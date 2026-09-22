/**
 * Paper-copy reporter: watches leader wallets, paper-trades their entries
 * (0.05 SOL, partial TP, trailing SL) and reports open/partial/close to
 * Telegram via grammy with MarkdownV2 formatting.
 *
 * No chain execution anywhere: Helius/DexScreener/RugCheck are read-only,
 * positions live in paper_state.json. Secrets are read from the environment
 * (or the ave_signal_trade .env) and never logged.
 */
import { Bot } from 'grammy';
import { convert } from 'telegram-markdown-v2';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import {
  DEFAULT_CONFIG,
  assessRug,
  asMs,
  auditLedger,
  expectedCashFromLegs,
  ledgerExpected,
  mcapBlocked,
  momentumBlocked,
  settleCloseLeg,
  settlePartial,
  sigsDelta,
  unrealizedPnlSol as calcUnrealized,
  walletDayAllowed,
  walletDayRecord,
  walletToxic,
  walletTradeStats,
  openPosition,
  tickPosition,
  positionPnlSol,
  openReport,
  partialReport,
  closeReport,
  startupReport,
  type Position,
} from './engine';

const DIR = new URL('.', import.meta.url).pathname;
const STATE_PATH = `${DIR}paper_state.json`;
const AVE_ENV = '/home/mdev/Programming/ave_signal_trade/.env';
const WATCHLIST_CSV = '/home/mdev/Programming/pump-wallets-final-v11-fixed/data/pump_wallet_exports/copy-watchlist.csv';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SWEEP_INTERVAL_MS = 300_000;
const PRICE_TICK_MS = 30_000;
const WALLET_SPACING_MS = 5000;
const HTTP_TIMEOUT_MS = 15_000;
const TRACK_TOP_N = 12;
const MIN_COPY_BUY_SOL = 0.05;
const MAX_OPEN_POSITIONS = 3;
const ENTRY_COOLDOWN_MS = 4 * 3600_000;
const MIN_LIQ_USD = 10_000;
const MAX_MCAP_USD = 3_000_000;
const MAX_AGE_HOURS = 72;
const RUG_MAX_SCORE = 50;
const START_BALANCE_SOL = 10;
// kEFiAX-class hyperactivity did 58/108 paper trades at -0.089 total: cap how
// many positions one wallet may open per UTC day to force diversification.
const MAX_OPENS_PER_WALLET_PER_DAY = 3;
// With minutes of copy latency behind the leader, buying into an already
// vertical 5-minute print means buying their top.
const MOMENTUM_MAX_M5_PCT = 20;
// Circuit breaker: this many Helius wallet errors in one sweep pauses NEW
// entries for 30 min (position management is never paused).
const BREAKER_SWEEP_ERRORS = 8;
const BREAKER_PAUSE_MS = 30 * 60_000;
// Hard blocklist: wallets proven toxic by the per-wallet report
// (kEFiAX3j: 65 trades exp -0.0014; FqQFrHQ7: 12 trades exp -0.0061).
// The adaptive walletToxic() filter below generalizes this to any wallet.
const BLOCKED_WALLETS: string[] = [
  'kEFiAX3jo5NmemysQov342TZ9mGh6yp92GDRjhA8XDf',
  'FqQFrHQ7YvRoFGdWjvSgRf58aDmcbgmoNV11DxDhnEzn',
];
// Cap on retained closed position objects (closed[] ledger is unaffected).
const MAX_KEEP_POSITIONS = 400;

type State = {
  // Core accounting: cash + positions = equity invariant
  cashSol: number;                    // Free cash available for new positions
  reservedSol: number;                // Cost basis locked in open positions (open fee is expensed, not reserved)
  realizedPnlSol: number;             // Cumulative realized PnL from closed positions
  unrealizedPnlSol: number;           // Current unrealized PnL on open positions
  
  positions: Position[];
  closed: Array<{ id: string; mint: string; symbol: string; wallet: string; pnlSol: number; win: boolean; atMs: number; holdMs: number; closeReason: string | null; leaderBuyTs?: number }>;
  lastSig: Record<string, string>;
  cooldownUntil: Record<string, number>;
  /** mint -> {wallets seen buying, first-seen ms}; prunes as it goes. Feeds the buyers24h count. */
  mintBuyers: Record<string, { wallets: string[]; sinceMs: number }>;
  /** wallet -> {UTC day, opens today}; bounds one actor's share of flow. */
  opensToday: Record<string, { day: string; count: number }>;
  /** One-time ledger anchor for pre-audit unrecorded credits (see engine). */
  auditOffset?: number;
  /** One-time anchor for the legs-based cash audit (pre-audit cash history). */
  cashAuditOffset?: number;
  /** One-time legacy gap fold into realized; never refold (would mask new drift). */
  gapFolded?: boolean;
};

export async function loadEnvFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* optional file */ }
  return out;
}

async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, 'utf8')) as State & { balanceSol?: number };
    s.mintBuyers ??= {};
    s.opensToday ??= {};
    // Migration from old single balance to new accounting
    if (s.balanceSol !== undefined && s.cashSol === undefined) {
      s.cashSol = s.balanceSol;
      s.reservedSol = 0;
      s.realizedPnlSol = 0;
      s.unrealizedPnlSol = 0;
      delete (s as any).balanceSol;
    }
    // One-time legacy gap fold so equity = START + realized + unrealized holds.
    // Gated by gapFolded: refolding on every boot would silently absorb NEW
    // accounting drift and defeat the audit. New drift must trip, not fold.
    if (!s.gapFolded && typeof s.cashSol === 'number' && typeof s.reservedSol === 'number' && typeof s.realizedPnlSol === 'number') {
      const gap = (s.cashSol + s.reservedSol) - START_BALANCE_SOL - s.realizedPnlSol;
      if (Math.abs(gap) > 0.0001) {
        console.warn(`loadState: one-time legacy gap fold ${gap >= 0 ? '+' : ''}${gap.toFixed(4)} into realized`);
        s.realizedPnlSol += gap;
      }
      s.gapFolded = true;
    }
    s.mintBuyers ??= {};
    s.opensToday ??= {};
    // Migrate existing positions to new accounting fields
    for (const pos of s.positions) {
      if (pos.sizeSol == null) pos.sizeSol = 0.05;
      if (pos.feeOpenSol == null) pos.feeOpenSol = 0.0002;
      if (pos.openQty == null) pos.openQty = pos.qtyTokens || 1;
      if (pos.reservedSol == null) {
        pos.reservedSol = pos.status === 'open'
          ? pos.sizeSol * ((pos.remainingQty || pos.qtyTokens || 0) / (pos.openQty || 1))
          : 0;
      }
      if (pos.cashBeforeSol === undefined) {
        pos.cashBeforeSol = pos.balanceBeforeSol;
        pos.cashAfterSol = pos.balanceBeforeSol - pos.sizeSol - pos.feeOpenSol;
        pos.reservedAfterSol = pos.sizeSol + pos.feeOpenSol;
        if (pos.stopPriceUsd == null) pos.stopPriceUsd = pos.entryPriceUsd * (1 - 0.15);
        pos.unrealizedPnlSol = pos.unrealizedPnlSol ?? 0;
        pos.pnlSol = pos.pnlSol ?? 0;
      }
      // Backfill ledger pnl from legs when close path left it at 0
      if (pos.status === 'closed' && pos.legs?.length) {
        const legSum = pos.legs.reduce((sum, l) => sum + (l.pnlSol || 0), 0);
        if (!pos.pnlSol && legSum !== 0) pos.pnlSol = legSum;
      }
    }
    // Clamp invalid reserved (legacy double-release bug)
    if (s.reservedSol < 0) s.reservedSol = 0;
    // Equity already holds under cash+reserved = start+realized (gap folded above).
    // Stale auditOffset from the old balance model would false-fail the new audit.
    if (s.auditOffset !== undefined) {
      const eq = s.cashSol + s.reservedSol;
      const exp = START_BALANCE_SOL + s.realizedPnlSol;
      if (Math.abs(eq - exp) <= 0.001) delete s.auditOffset;
    }
    return s;
  } catch {
    return { 
      cashSol: START_BALANCE_SOL, 
      reservedSol: 0, 
      realizedPnlSol: 0, 
      unrealizedPnlSol: 0,
      positions: [], 
      closed: [], 
      lastSig: {}, 
      cooldownUntil: {}, 
      mintBuyers: {}, 
      opensToday: {} 
    };
  }
}

/** Tracked wallets seen buying a mint in the last 24h (prunes as it goes). */
function noteBuyer(state: State, mint: string, wallet: string, nowMs: number): number {
  const day = 24 * 3600_000;
  for (const [m, e] of Object.entries(state.mintBuyers)) {
    if (nowMs - e.sinceMs > day) delete state.mintBuyers[m];
  }
  const e = state.mintBuyers[mint] ?? { wallets: [], sinceMs: nowMs };
  if (!e.wallets.includes(wallet)) e.wallets.push(wallet);
  state.mintBuyers[mint] = e;
  return e.wallets.length;
}

/** Bound state growth: keep all open positions + most recent closed ones.
 * The closed[] ledger (report source of truth) is never pruned. */
function prunePositions(state: State): void {
  if (state.positions.length <= MAX_KEEP_POSITIONS) return;
  const open = state.positions.filter((p) => p.status === 'open');
  const closed = state.positions
    .filter((p) => p.status !== 'open')
    .sort((a, b) => (b.legs.at(-1)?.atMs ?? b.openedAtMs) - (a.legs.at(-1)?.atMs ?? a.openedAtMs));
  state.positions = [...open, ...closed.slice(0, Math.max(0, MAX_KEEP_POSITIONS - open.length))];
}

async function saveState(s: State): Promise<void> {
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, STATE_PATH);
  // Rolling backup: a corrupt/partial state write must never be the only copy.
  try {
    await writeFile(`${STATE_PATH}.bak`, JSON.stringify(s));
  } catch { /* backup is best-effort */ }
}



async function fetchJson(url: string, init?: RequestInit, timeoutMs = HTTP_TIMEOUT_MS): Promise<unknown> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url: string, body: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<unknown> {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify(body),
  }, timeoutMs);
}

function coolOnAuthError(pool: KeyPool, key: string, e: unknown): void {
  if (String(e).includes('401') || String(e).includes('403') || String(e).includes('429')) pool.cool(key);
}

/** Tier 1: cheap newest-first signatures (10 credits flat) for change detection. */
async function gtfaSignatures(pool: KeyPool, wallet: string, limit: number): Promise<string[]> {
  const key = pool.next();
  try {
    const d = (await postJson(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      jsonrpc: '2.0',
      id: 'sigs',
      method: 'getTransactionsForAddress',
      params: [wallet, { transactionDetails: 'signatures', limit, sortOrder: 'desc' }],
    })) as { result?: { data?: Array<{ signature?: string }> } };
    return (d?.result?.data ?? []).map((r) => r.signature ?? '').filter(Boolean);
  } catch (e) {
    coolOnAuthError(pool, key, e);
    throw e;
  }
}

/** Tier 2: full Enhanced parse (100 credits) — only for the fresh delta. */
async function enhancedHistory(pool: KeyPool, wallet: string, limit: number): Promise<EnhancedTx[]> {
  const key = pool.next();
  try {
    const txs = (await fetchJson(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=${limit}`,
    )) as EnhancedTx[];
    if (!Array.isArray(txs)) throw new Error('bad enhanced response');
    return txs;
  } catch (e) {
    coolOnAuthError(pool, key, e);
    throw e;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Round-robin Helius keys with cooldown on 401/403/429. */
class KeyPool {
  private keys: string[];
  private coolUntil = new Map<string, number>();
  private idx = 0;
  constructor(keys: string[]) {
    this.keys = keys.filter(Boolean);
    if (!this.keys.length) throw new Error('no Helius keys');
  }
  next(): string {
    for (let n = 0; n < this.keys.length; n += 1) {
      const k = this.keys[this.idx % this.keys.length]!;
      this.idx += 1;
      if ((this.coolUntil.get(k) ?? 0) < Date.now()) return k;
    }
    return this.keys[this.idx++ % this.keys.length]!;
  }
  cool(key: string, ms = 600_000): void {
    this.coolUntil.set(key, Date.now() + ms);
  }
  snapshot(): string[] {
    return [...this.keys];
  }
  drop(key: string): void {
    this.keys = this.keys.filter((k) => k !== key);
  }
  size(): number {
    return this.keys.length;
  }
}

type Tracked = { wallet: string; tokens: string };
async function loadTracked(): Promise<Tracked[]> {
  const rows = (await readFile(WATCHLIST_CSV, 'utf8')).trim().split('\n').slice(1);
  return rows
    .map((line) => {
      const [wallet = '', tokens = '0'] = line.split(',');
      return { wallet: wallet.trim(), tokens: tokens.trim() };
    })
    .filter((r) => r.wallet.length > 30)
    .slice(0, TRACK_TOP_N);
}

type DexInfo = { priceUsd: number | null; liqUsd: number | null; mcapUsd: number | null; ageHours: number | null; symbol: string; chgM5: number | null };
async function dexBatch(mints: string[]): Promise<Map<string, DexInfo>> {
  const out = new Map<string, DexInfo>();
  if (!mints.length) return out;
  const data = (await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`)) as Array<Record<string, unknown>>;
  for (const p of Array.isArray(data) ? data : []) {
    const base = p['baseToken'] as Record<string, string>;
    const addr: string = base?.['address'] ?? '';
    if (!addr) continue;
    if (out.has(addr)) {
      // Keep the highest-liquidity pair per token.
      const liq = Number((p['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? 0);
      const prev = out.get(addr);
      if (prev && (prev.liqUsd ?? 0) >= liq) continue;
    }
    const created = p['pairCreatedAt'] as number | undefined;
    const chg = (p['priceChange'] as Record<string, unknown> | undefined) ?? {};
    out.set(addr, {
      priceUsd: p['priceUsd'] === null ? null : Number(p['priceUsd']),
      liqUsd: Number((p['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? NaN) || null,
      mcapUsd: (p['marketCap'] as number | undefined) ?? null,
      ageHours: created ? (Date.now() - created) / 3600_000 : null,
      symbol: base?.['symbol'] ?? addr.slice(0, 8),
      chgM5: typeof chg['m5'] === 'number' ? (chg['m5'] as number) : null,
    });
  }
  return out;
}

async function rugSummary(mint: string): Promise<unknown> {
  return fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
}

async function solUsd(): Promise<number | null> {
  // DexScreener primary: Jupiter price v3 is Cloudflare-gated for non-browser
  // clients (HTTP 1010), which starved entries of SOL/USD entirely.
  try {
    const d = (await fetchJson(
      'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112',
    )) as Array<Record<string, unknown>>;
    const px = (Array.isArray(d) ? d : [])
      .map((p) => Number(p['priceUsd'] ?? NaN))
      .find((v) => Number.isFinite(v) && v > 0);
    if (px !== undefined) return px;
  } catch { /* fall through to Jupiter */ }
  try {
    const d = (await fetchJson('https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112')) as Record<string, Record<string, number>>;
    return d?.['So11111111111111111111111111111111111111112']?.['price'] ?? null;
  } catch {
    return null;
  }
}

type EnhancedTx = {
  signature: string;
  timestamp: number;
  type?: string;
  feePayer?: string;
  tokenTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; mint?: string; tokenAmount?: number }>;
  nativeTransfers?: Array<{ fromUserAccount?: string; toUserAccount?: string; amount?: number }>;
};

type BuyEvent = { mint: string; solPaid: number; sig: string; ts: number };

/**
 * Two-tier wallet watch: Tier 1 GTFA signatures (10 credits flat) detect
 * change; Tier 2 Enhanced (100 credits) parses only the fresh delta. A quiet
 * wallet costs 10 credits instead of 100 — ~10x cheaper at idle.
 */
async function recentBuys(
  pool: KeyPool,
  wallet: string,
  sinceSig: string | null,
): Promise<{ buys: BuyEvent[]; newestSig: string | null; credits: number }> {
  const buys: BuyEvent[] = [];
  const sigs = await gtfaSignatures(pool, wallet, 100);
  let credits = 10;
  const { fresh, newest } = sigsDelta(sigs, sinceSig);
  if (fresh === 0) return { buys, newestSig: newest ?? sinceSig, credits };
  if (fresh >= sigs.length && sigs.length > 0) {
    console.log(`gap larger than signature window for ${wallet.slice(0, 8)}, oldest skipped`);
  }
  const txs = await enhancedHistory(pool, wallet, Math.min(fresh + 5, 100));
  credits += 100;
  const freshSet = new Set(sigs.slice(0, fresh));
  for (const t of txs) {
    if (!freshSet.has(t.signature)) continue;
    if ((t.type ?? '').toUpperCase() !== 'SWAP') continue;
    for (const tr of t.tokenTransfers ?? []) {
      if (tr.toUserAccount !== wallet || !tr.mint || tr.mint === SOL_MINT) continue;
      const paid = (t.nativeTransfers ?? [])
        .filter((n) => n.fromUserAccount === wallet)
        .reduce((s, n) => s + (n.amount ?? 0), 0) / 1e9;
      if (paid >= MIN_COPY_BUY_SOL) buys.push({ mint: tr.mint, solPaid: paid, sig: t.signature, ts: asMs(t.timestamp) });
    }
  }
  return { buys, newestSig: newest, credits };
}

async function main(): Promise<void> {
  const envFile = await loadEnvFile(AVE_ENV);
  const botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? envFile['TELEGRAM_BOT_TOKEN'] ?? '';
  const chatId = process.env['TELEGRAM_CHAT_ID'] ?? envFile['TELEGRAM_CHAT_ID'] ?? '';
  if (!botToken || !chatId) throw new Error('missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID');
  const heliusKeys = (
    process.env['HELIUS_API_KEYS'] ??
    [envFile['HELIUS_API_KEYS'], envFile['HELIUS_API_KEY']].filter(Boolean).join(',')
  ).split(',').map((s) => s.trim()).filter(Boolean);
  const pool = new KeyPool(heliusKeys);

  const bot = new Bot(botToken);
  const send = async (md: string): Promise<void> => {
    const msg = await bot.api.sendMessage(chatId, convert(md), { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
    console.log(`telegram delivered message_id=${msg.message_id}`);
  };

  // Boot probe: drop dead Helius keys before the sweep loop burns calls on
  // them. GTFA signatures (10 credits) instead of Enhanced (100).
  for (const k of pool.snapshot()) {
    try {
      await postJson(`https://mainnet.helius-rpc.com/?api-key=${k}`, {
        jsonrpc: '2.0',
        id: 'probe',
        method: 'getTransactionsForAddress',
        params: ['kEFiAX3jo5NmemysQov342TZ9mGh6yp92GDRjhA8XDf', { transactionDetails: 'signatures', limit: 1, sortOrder: 'desc' }],
      });
    } catch {
      pool.drop(k);
      console.log('dropping dead Helius key from rotation');
    }
    await sleep(1500);
  }
  if (pool.size() === 0) throw new Error('no working Helius keys');

  const tracked = await loadTracked();
  const state = await loadState();
  const cfg = DEFAULT_CONFIG;
  let solUsdCache: number | null = await solUsd();

  const stats = (): { closed: number; wins: number; totalPnlSol: number } => {
    const wins = state.closed.filter((c) => c.pnlSol > 0).length;
    return { closed: state.closed.length, wins, totalPnlSol: state.closed.reduce((s, c) => s + c.pnlSol, 0) };
  };

  for (let i = 0; i < 3; i += 1) {
    try {
      await send(startupReport(cfg, tracked.length, state.cashSol, state.reservedSol, state.unrealizedPnlSol));
      break;
    } catch (e) {
      console.warn(`startup report attempt ${i + 1} failed`, String(e).slice(0, 120));
      if (i === 2) console.warn('continuing without startup card');
      else await sleep(2000);
    }
  }
  console.log(`paper-copy live: ${tracked.length} wallets, cash ${state.cashSol.toFixed(4)} | reserved ${state.reservedSol.toFixed(4)} | unrealized ${state.unrealizedPnlSol.toFixed(4)} | equity ${(state.cashSol + state.reservedSol + state.unrealizedPnlSol).toFixed(4)}`);

  const priceTick = async (): Promise<void> => {
    const open = state.positions.filter((p) => p.status === 'open');
    if (!open.length) return;
    let info: Map<string, DexInfo>;
    try {
      info = await dexBatch([...new Set(open.map((p) => p.mint))]);
    } catch (e) {
      console.warn('price tick failed', String(e).slice(0, 120));
      return;
    }
    let totalUnrealized = 0;
    for (const pos of open) {
      const px = info.get(pos.mint)?.priceUsd;
      if (!px) continue;
      pos.unrealizedPnlSol = calcUnrealized(pos, px);
      totalUnrealized += pos.unrealizedPnlSol;
    }
    state.unrealizedPnlSol = totalUnrealized;
    const equity = state.cashSol + state.reservedSol + totalUnrealized;
    const expectedEquity = START_BALANCE_SOL + state.realizedPnlSol + totalUnrealized;
    if (Math.abs(equity - expectedEquity) > 0.01) {
      console.warn(`EQUITY DRIFT: equity=${equity.toFixed(4)} expected=${expectedEquity.toFixed(4)}`);
    }
    let dirty = false;
    const now = Date.now();
    for (const pos of open) {
      const px = info.get(pos.mint)?.priceUsd;
      if (!px) continue;
      const ev = tickPosition(cfg, pos, px, now);
      for (const leg of ev.partials) {
        // Single money path (engine.settlePartial): proceeds, reserved share,
        // realized leg PnL. Engine already reduced remainingQty; sync display qty.
        const cashBefore = state.cashSol;
        settlePartial(cfg, state, pos, leg);
        pos.unrealizedPnlSol = calcUnrealized(pos, px);
        dirty = true;
        pos.cashBeforeSol = cashBefore;
        pos.cashAfterSol = state.cashSol;
        pos.reservedAfterSol = pos.reservedSol;
        await send(partialReport(cfg, pos, leg, solUsdCache));
      }
      if (ev.closed) {
        const last = pos.legs.at(-1);
        // Ladder-complete pops the last partial from ev.partials and closeRest
        // pushes only to pos.legs: the closing leg is settled here exactly once.
        if (last && !ev.partials.includes(last)) {
          settleCloseLeg(cfg, state, pos, last);
        } else {
          // Defensive (e.g. zero-qty guard pushed no leg): release leftovers.
          if ((pos.reservedSol ?? 0) > 0) {
            state.reservedSol -= pos.reservedSol!;
            pos.reservedSol = 0;
          }
          pos.qtyTokens = 0;
          pos.remainingQty = 0;
          if (state.reservedSol < 0) state.reservedSol = 0;
        }
        const legSum = positionPnlSol(pos);
        pos.pnlSol = legSum;
        const net = legSum - (pos.feeOpenSol ?? 0);
        pos.unrealizedPnlSol = 0;
        const holdMs = now - pos.openedAtMs;
        state.closed.push({
          id: pos.id,
          mint: pos.mint,
          symbol: pos.symbol,
          wallet: pos.wallet,
          pnlSol: net,
          win: net > 0,
          atMs: now,
          holdMs,
          closeReason: pos.closeReason,
          leaderBuyTs: pos.leaderBuyTs,
        });
        pos.status = 'closed';
        dirty = true;
        await send(closeReport(cfg, pos, state.cashSol, solUsdCache, stats()));
      }
    }
    if (dirty) {
      // Recompute global unrealized from survivors only: closing one position
      // must not zero the unrealized of the rest.
      state.unrealizedPnlSol = state.positions
        .filter((q) => q.status === 'open')
        .reduce((sum, q) => sum + (q.unrealizedPnlSol || 0), 0);
      prunePositions(state);
      await saveState(state);
    }
  };

  // Declared up here: sweepWithErrors reads it, and `let` is TDZ-sensitive.
  let breakerUntilMs = 0;
  const sweepWithErrors = async (): Promise<{ fresh: number; errors: number; credits: number }> => {
    let fresh = 0;
    let errors = 0;
    let credits = 0;
    let dirty = false;
    const entriesPaused = Date.now() < breakerUntilMs;
    for (const t of tracked) {
      try {
        const r = await recentBuys(pool, t.wallet, state.lastSig[t.wallet] ?? null);
        credits += r.credits;
        if (r.newestSig) state.lastSig[t.wallet] = r.newestSig;
        const { buys } = r;
        fresh += buys.length;
        dirty = true; // lastSig cursor advanced
        if (entriesPaused) {
          await sleep(WALLET_SPACING_MS);
          continue;
        }
        for (const b of buys) {
          if (state.positions.some((p) => p.status === 'open' && p.mint === b.mint)) continue;
          // One open position per wallet: kEFiAX-class hyperactivity would
          // otherwise fill every slot with correlated bets on one actor.
          if (state.positions.some((p) => p.status === 'open' && p.wallet === t.wallet)) {
            console.log(`skip ${b.mint.slice(0, 8)}: wallet already has an open position`);
            continue;
          }
          if (state.positions.filter((p) => p.status === 'open').length >= MAX_OPEN_POSITIONS) break;
          if ((state.cooldownUntil[`${t.wallet}:${b.mint}`] ?? 0) > Date.now()) continue;
          if (!walletDayAllowed(state.opensToday, t.wallet, Date.now(), MAX_OPENS_PER_WALLET_PER_DAY)) {
            console.log(`skip ${b.mint.slice(0, 8)}: wallet daily budget exhausted`);
            continue;
          }
          if (BLOCKED_WALLETS.includes(t.wallet)) {
            console.log(`skip ${b.mint.slice(0, 8)}: wallet blocklisted (proven toxic)`);
            continue;
          }
          if (walletToxic(state.closed, t.wallet)) {
            const st = walletTradeStats(state.closed, t.wallet);
            console.log(`skip ${b.mint.slice(0, 8)}: wallet toxic (${st.n} closed, exp ${st.expectancySol.toFixed(4)})`);
            continue;
          }
          const info = (await dexBatch([b.mint])).get(b.mint);
          if (!info?.priceUsd) continue;
          if (momentumBlocked(info.chgM5, MOMENTUM_MAX_M5_PCT)) {
            console.log(`skip ${b.mint.slice(0, 8)}: vertical m5 (+${info.chgM5}%), not chasing`);
            continue;
          }
          if ((info.liqUsd ?? 0) < MIN_LIQ_USD) continue;
          // Unknown mcap passes: DexScreener gaps must not block flow.
          if (mcapBlocked(info.mcapUsd, MAX_MCAP_USD)) {
            console.log(`skip ${b.mint.slice(0, 8)}: mcap ${info.mcapUsd} over cap`);
            continue;
          }
          if ((info.ageHours ?? 0) > MAX_AGE_HOURS) continue;
          let rug: number | null = null;
          try {
            const assessment = assessRug(await rugSummary(b.mint));
            rug = assessment.score;
            if (assessment.veto) {
              console.log(`rug veto ${b.mint} ${assessment.reason}`);
              continue;
            }
            if (assessment.score !== null && assessment.score > RUG_MAX_SCORE) {
              console.log(`rug warn ${b.mint} ${assessment.reason} (warn-only, proceeding)`);
            }
          } catch {
            console.log(`rug unavailable for ${b.mint} (warn-only, proceeding)`);
          }
          if (state.cashSol < cfg.posSizeSol + cfg.feeOpenSol) {
            console.log('insufficient paper balance, skipping entry');
            continue;
          }
          const solUsdNow = solUsdCache;
          if (solUsdNow === null) {
            console.log('no SOL/USD yet, skipping entry');
            continue;
          }
          const buyers24h = noteBuyer(state, b.mint, t.wallet, Date.now());
          const pos = openPosition(cfg, {
            id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
            mint: b.mint,
            symbol: info.symbol,
            wallet: t.wallet,
            walletLabel: `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)} (${t.tokens}tok)`,
            entryPriceUsd: info.priceUsd,
            solUsdAtEntry: solUsdNow,
            atMs: Date.now(),
            balanceBeforeSol: state.cashSol,
            buyers24h,
            liqUsd: info.liqUsd,
            mcapUsd: info.mcapUsd,
            ageHours: info.ageHours,
            rugScore: rug,
            leaderBuyTs: b.ts,
          });
          state.cashSol -= cfg.posSizeSol + cfg.feeOpenSol;
          state.reservedSol += cfg.posSizeSol;
          state.realizedPnlSol -= cfg.feeOpenSol;
          state.positions.push(pos);
          state.cooldownUntil[`${t.wallet}:${b.mint}`] = Date.now() + ENTRY_COOLDOWN_MS;
          walletDayRecord(state.opensToday, t.wallet, Date.now());
          dirty = true;
          await saveState(state);
          await send(openReport(cfg, pos, state.cashSol, state.reservedSol, solUsdCache));
        }
        dirty = true;
      } catch (e) {
        errors += 1;
        console.warn(`sweep ${t.wallet.slice(0, 8)} failed`, String(e).slice(0, 120));
      }
      await sleep(WALLET_SPACING_MS);
    }
    if (dirty) await saveState(state);
    return { fresh, errors, credits };
  };

  // Price ticks every 30s idle, 15s while positions are open (TP levels live
  // and die between 30s ticks in this market); wallet sweep every 5 min.
  const priceLoop = async (): Promise<void> => {
    for (;;) {
      await priceTick().catch((e) => console.warn('tick', String(e).slice(0, 120)));
      const hasOpen = state.positions.some((p) => p.status === 'open');
      await sleep(hasOpen ? 15_000 : PRICE_TICK_MS);
    }
  };
  // consecutive sweeps hitting the breaker threshold pause NEW entries
  // (position management is never paused).
  const sweepLoop = async (): Promise<void> => {
    for (;;) {
      solUsdCache = (await solUsd().catch(() => solUsdCache)) ?? solUsdCache;
      const t0 = Date.now();
      let fresh = 0;
      let heliusErrors = 0;
      let credits = 0;
      try {
        const r = await sweepWithErrors();
        fresh = r.fresh;
        heliusErrors = r.errors;
        credits = r.credits;
      } catch (e) {
        console.warn('sweep', String(e).slice(0, 120));
        heliusErrors = TRACK_TOP_N;
      }
      if (heliusErrors >= BREAKER_SWEEP_ERRORS) {
        breakerUntilMs = Date.now() + BREAKER_PAUSE_MS;
        console.warn(`CIRCUIT BREAKER: ${heliusErrors} Helius errors, new entries paused 30m (management continues)`);
      } else if (heliusErrors === 0) {
        breakerUntilMs = 0;
      }
      const paused = Date.now() < breakerUntilMs;
      const open = state.positions.filter((p) => p.status === 'open').length;
      // Ledger self-audit every sweep: equity identity plus an independent
      // legs-based cash recompute (different formula path than the credit path).
      const auditArgs = {
        startBalance: START_BALANCE_SOL,
        balance: state.cashSol,
        positions: state.positions,
        posSize: cfg.posSizeSol,
        feeOpen: cfg.feeOpenSol,
        feeLeg: cfg.feeLegSol,
        realized: state.realizedPnlSol,
        reserved: state.reservedSol,
        legacyOffset: state.auditOffset,
        cash: state.cashSol,
        cashOffset: state.cashAuditOffset,
      };
      let problem = auditLedger(auditArgs);
      if (problem && problem.startsWith('equity drift') && state.auditOffset === undefined) {
        // One-time anchor for pre-model books; new drift past the anchor trips.
        const anchored = (state.cashSol + state.reservedSol) - START_BALANCE_SOL - state.realizedPnlSol;
        state.auditOffset = anchored;
        await saveState(state);
        console.warn(`LEDGER AUDIT: anchoring legacy offset ${anchored >= 0 ? '+' : ''}${anchored.toFixed(4)} (pre-model equity); watching for new drift`);
        problem = auditLedger({ ...auditArgs, legacyOffset: anchored });
      }
      if (problem && problem.startsWith('cash drift') && state.cashAuditOffset === undefined) {
        // One-time anchor for pre-audit cash history; new drift past it trips.
        const recomputed = expectedCashFromLegs(auditArgs);
        if (Number.isFinite(recomputed)) {
          const anchoredCash = state.cashSol - recomputed;
          state.cashAuditOffset = anchoredCash;
          await saveState(state);
          console.warn(`LEDGER AUDIT: anchoring cash offset ${anchoredCash >= 0 ? '+' : ''}${anchoredCash.toFixed(4)} (pre-audit cash history); watching for new drift`);
          problem = auditLedger({ ...auditArgs, cashOffset: anchoredCash });
        }
      }
      if (problem) console.warn(`LEDGER AUDIT: ${problem}`);
      // Heartbeat every sweep: proves liveness even when the market is quiet
      // (no entries/exits), which the log-freshness health check needs.
      console.log(`sweep complete: ${tracked.length} wallets, ${fresh} fresh buys, ${open} open, cash ${state.cashSol.toFixed(4)} SOL, ~${credits}cr, ${((Date.now() - t0) / 1000).toFixed(0)}s${paused ? ' BREAKER-PAUSED' : ''}${problem ? ' AUDIT-FAIL' : ''}`);
      await sleep(SWEEP_INTERVAL_MS);
    }
  };
  await Promise.all([priceLoop(), sweepLoop()]);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
