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

type State = {
  balanceSol: number;
  positions: Position[];
  closed: Array<{ id: string; mint: string; symbol: string; pnlSol: number; win: boolean; atMs: number }>;
  lastSig: Record<string, string>;
  cooldownUntil: Record<string, number>;
  /** mint -> {wallets seen buying, first-seen ms}; pruned past 24h. Feeds the buyers24h count. */
  mintBuyers: Record<string, { wallets: string[]; sinceMs: number }>;
};

async function loadEnvFile(path: string): Promise<Record<string, string>> {
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
    const s = JSON.parse(await readFile(STATE_PATH, 'utf8')) as State;
    s.mintBuyers ??= {};
    return s;
  } catch {
    return { balanceSol: START_BALANCE_SOL, positions: [], closed: [], lastSig: {}, cooldownUntil: {}, mintBuyers: {} };
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

async function saveState(s: State): Promise<void> {
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, STATE_PATH);
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

type DexInfo = { priceUsd: number | null; liqUsd: number | null; mcapUsd: number | null; ageHours: number | null; symbol: string };
async function dexBatch(mints: string[]): Promise<Map<string, DexInfo>> {
  const out = new Map<string, DexInfo>();
  if (!mints.length) return out;
  const data = (await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`)) as Array<Record<string, unknown>>;
  for (const p of Array.isArray(data) ? data : []) {
    const base = p['baseToken'] as Record<string, string>;
    const addr: string = base?.['address'] ?? '';
    if (!addr || out.has(addr)) {
      // Keep the highest-liquidity pair per token.
      const liq = Number((p['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? 0);
      const prev = out.get(addr);
      if (prev && (prev.liqUsd ?? 0) >= liq) continue;
    }
    const created = p['pairCreatedAt'] as number | undefined;
    out.set(addr, {
      priceUsd: p['priceUsd'] === null ? null : Number(p['priceUsd']),
      liqUsd: Number((p['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? NaN) || null,
      mcapUsd: (p['marketCap'] as number | undefined) ?? null,
      ageHours: created ? (Date.now() - created) / 3600_000 : null,
      symbol: base?.['symbol'] ?? addr.slice(0, 8),
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

async function recentBuys(pool: KeyPool, wallet: string, sinceSig: string | null): Promise<{ buys: Array<{ mint: string; solPaid: number; sig: string; ts: number }>; newestSig: string | null }> {
  const buys: Array<{ mint: string; solPaid: number; sig: string; ts: number }> = [];
  let newestSig: string | null = null;
  const key = pool.next();
  try {
    const txs = (await fetchJson(
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key}&limit=10`,
    )) as EnhancedTx[];
    if (!Array.isArray(txs)) return { buys, newestSig };
    for (const t of txs) {
      if (!newestSig) newestSig = t.signature;
      if (sinceSig && t.signature === sinceSig) break;
      if ((t.type ?? '').toUpperCase() !== 'SWAP') continue;
      for (const tr of t.tokenTransfers ?? []) {
        if (tr.toUserAccount !== wallet || !tr.mint || tr.mint === SOL_MINT) continue;
        const paid = (t.nativeTransfers ?? [])
          .filter((n) => n.fromUserAccount === wallet)
          .reduce((s, n) => s + (n.amount ?? 0), 0) / 1e9;
        if (paid >= MIN_COPY_BUY_SOL) buys.push({ mint: tr.mint, solPaid: paid, sig: t.signature, ts: t.timestamp });
      }
      if (sinceSig === null) break; // first boot: only mark position, never backfill
    }
  } catch (e) {
    if (String(e).includes('401') || String(e).includes('403') || String(e).includes('429')) pool.cool(key);
    throw e;
  }
  return { buys, newestSig };
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

  // Boot probe: drop dead Helius keys before the sweep loop burns calls on them.
  for (const k of pool.snapshot()) {
    try {
      await fetchJson(`https://api.helius.xyz/v0/addresses/kEFiAX3jo5NmemysQov342TZ9mGh6yp92GDRjhA8XDf/transactions?api-key=${k}&limit=1`);
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

  await send(startupReport(cfg, tracked.length, state.balanceSol));
  console.log(`paper-copy live: ${tracked.length} wallets, balance ${state.balanceSol} SOL`);

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
    const now = Date.now();
    let dirty = false;
    for (const pos of open) {
      const px = info.get(pos.mint)?.priceUsd;
      if (!px) continue;
      const ev = tickPosition(cfg, pos, px, now);
      for (const leg of ev.partials) {
        state.balanceSol += (leg.qtyTokens / pos.qtyTokens) * cfg.posSizeSol * (leg.priceUsd / pos.entryPriceUsd) - cfg.feeLegSol;
        dirty = true;
        await send(partialReport(pos, leg, solUsdCache));
      }
      if (ev.closed) {
        const last = pos.legs.at(-1)!;
        state.balanceSol += (last.qtyTokens / pos.qtyTokens) * cfg.posSizeSol * (last.priceUsd / pos.entryPriceUsd) - cfg.feeLegSol;
        const pnl = positionPnlSol(pos) - cfg.feeOpenSol;
        state.closed.push({ id: pos.id, mint: pos.mint, symbol: pos.symbol, pnlSol: pnl, win: pnl > 0, atMs: now });
        dirty = true;
        await send(closeReport(cfg, pos, state.balanceSol, solUsdCache, stats()));
      }
    }
    if (dirty) await saveState(state);
  };

  const sweep = async (): Promise<void> => {
    for (const t of tracked) {
      try {
        const { buys, newestSig } = await recentBuys(pool, t.wallet, state.lastSig[t.wallet] ?? null);
        if (newestSig) state.lastSig[t.wallet] = newestSig;
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
          const info = (await dexBatch([b.mint])).get(b.mint);
          if (!info?.priceUsd) continue;
          if ((info.liqUsd ?? 0) < MIN_LIQ_USD) continue;
          if ((info.mcapUsd ?? Infinity) > MAX_MCAP_USD) continue;
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
          if (state.balanceSol < cfg.posSizeSol + cfg.feeOpenSol) {
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
            balanceBeforeSol: state.balanceSol,
            buyers24h,
            liqUsd: info.liqUsd,
            mcapUsd: info.mcapUsd,
            ageHours: info.ageHours,
            rugScore: rug,
          });
          state.balanceSol -= cfg.posSizeSol + cfg.feeOpenSol;
          state.positions.push(pos);
          state.cooldownUntil[`${t.wallet}:${b.mint}`] = Date.now() + ENTRY_COOLDOWN_MS;
          await saveState(state);
          await send(openReport(cfg, pos, state.balanceSol, solUsdCache));
        }
        await saveState(state);
      } catch (e) {
        console.warn(`sweep ${t.wallet.slice(0, 8)} failed`, String(e).slice(0, 120));
      }
      await sleep(WALLET_SPACING_MS);
    }
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
  const sweepLoop = async (): Promise<void> => {
    for (;;) {
      solUsdCache = (await solUsd().catch(() => solUsdCache)) ?? solUsdCache;
      await sweep().catch((e) => console.warn('sweep', String(e).slice(0, 120)));
      await sleep(SWEEP_INTERVAL_MS);
    }
  };
  await Promise.all([priceLoop(), sweepLoop()]);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
