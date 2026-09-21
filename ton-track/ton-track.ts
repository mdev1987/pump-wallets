/**
 * TON paper tracker: DexScreener price tracking + two what-if paper scenarios
 * (entry-now exact, entry-4h-ago estimated) on one TON token, reported to a
 * dedicated Telegram bot via grammy + MarkdownV2.
 *
 * Read-only market data, paper ledger in ton_state.json, no chain execution.
 */
import { Bot } from 'grammy';
import { convert } from 'telegram-markdown-v2';
import { readFile, writeFile, rename } from 'node:fs/promises';
import {
  TON_CONFIG,
  estimatePriceHoursAgo,
  type DexQuote,
} from './track';
import {
  openPosition,
  tickPosition,
  positionPnlSol,
  openReport,
  partialReport,
  closeReport,
  startupReport,
  type Position,
} from '../paper-copy/engine';

const DIR = new URL('.', import.meta.url).pathname;
const STATE_PATH = `${DIR}ton_state.json`;
const AVE_ENV = '/home/mdev/Programming/ave_signal_trade/.env';

const MINT = process.env['TON_MINT'] ?? 'EQCXA4bBsLMvftVAGvZuLJjK4k0sfewUOz7ZyVA57na2u7bY';
const SYMBOL = process.env['TON_SYMBOL'] ?? 'RizzGram';
const PAPER_USD = Number(process.env['TON_PAPER_USD'] ?? 25);
const POLL_MS = Number(process.env['TON_POLL_SEC'] ?? 60) * 1000;
const START_BANK_USD = 1000;

type State = {
  balanceUsd: number;
  scenarios: Array<{ name: 'now' | 'late4h'; pos: Position; estimatedEntry: boolean; entryNote: string }>;
  closed: Array<{ scenario: string; symbol: string; pnlSol: number; win: boolean; atMs: number }>;
  initializedAtMs: number | null;
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
  } catch { /* optional */ }
  return out;
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as State;
  } catch {
    return { balanceUsd: START_BANK_USD, scenarios: [], closed: [], initializedAtMs: null };
  }
}

async function saveState(s: State): Promise<void> {
  const tmp = `${STATE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2));
  await rename(tmp, STATE_PATH);
}

async function fetchJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function dexQuote(mint: string): Promise<DexQuote | null> {
  try {
    const data = (await fetchJson(`https://api.dexscreener.com/tokens/v1/ton/${mint}`)) as Array<Record<string, unknown>>;
    const pairs = Array.isArray(data) ? data : [];
    if (!pairs.length) return null;
    pairs.sort((a, b) => Number((b['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? 0) - Number((a['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? 0));
    const p = pairs[0]!;
    const base = p['baseToken'] as Record<string, string>;
    const txns = p['txns'] as Record<string, Record<string, number>> | undefined;
    const chg = (p['priceChange'] as Record<string, number> | undefined) ?? {};
    return {
      priceUsd: p['priceUsd'] === null ? null : Number(p['priceUsd']),
      liqUsd: Number((p['liquidity'] as Record<string, unknown> | undefined)?.['usd'] ?? NaN) || null,
      mcapUsd: (p['marketCap'] as number | undefined) ?? null,
      vol24Usd: Number((p['volume'] as Record<string, unknown> | undefined)?.['h24'] ?? NaN) || null,
      buys24h: txns?.['h24']?.['buys'] ?? null,
      chgH1: chg['h1'] ?? null,
      chgH6: chg['h6'] ?? null,
      chgH24: chg['h24'] ?? null,
      symbol: base?.['symbol'] ?? SYMBOL,
      dex: String(p['dexId'] ?? '?'),
      pairCreatedAtMs: (p['pairCreatedAt'] as number | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/** Resolve a usable chat: configured id first, else learn it from getUpdates. */
async function resolveChat(bot: Bot, configured: string): Promise<string> {
  if (configured) {
    try {
      await bot.api.sendChatAction(configured, 'typing');
      return configured;
    } catch (e) {
      console.log(`configured chat unusable (${String(e).slice(0, 100)}), listening for /start via getUpdates`);
    }
  } else {
    console.log('no chat configured, listening for /start via getUpdates');
  }
  let offset = 0;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const d = (await fetchJson(
        `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${offset}&timeout=25`,
        35_000,
      )) as { ok: boolean; result: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }> };
      for (const u of d.result ?? []) {
        offset = Math.max(offset, u.update_id + 1);
        const chat = u.message?.chat.id;
        if (chat !== undefined) return String(chat);
      }
    } catch (e) {
      console.log('getUpdates failed', String(e).slice(0, 80));
      await sleep(10_000);
    }
  }
  throw new Error('no Telegram chat found: message the bot (/start) or set TON_CHAT_ID');
}

async function localSecret(name: string): Promise<string> {
  try {
    return (await readFile(`${DIR}.token`, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const envFile = await loadEnvFile(AVE_ENV);
  // Token precedence: env -> local 600-perm .token file (gitignored).
  // Chat: learned once via getUpdates, then cached to .chat (gitignored).
  let chatCache = '';
  try {
    chatCache = (await readFile(`${DIR}.chat`, 'utf8')).trim();
  } catch { /* first boot */ }
  const botToken = process.env['TON_BOT_TOKEN'] ?? (await localSecret('token')) ?? process.env['TELEGRAM_BOT_TOKEN'] ?? '';
  // NOTE: no TON_CHAT_ID exists yet; reuse the operator chat as first guess.
  const chatGuess = chatCache || process.env['TON_CHAT_ID'] || process.env['TELEGRAM_CHAT_ID'] || envFile['TELEGRAM_CHAT_ID'] || '';
  if (!botToken) throw new Error('missing TON_BOT_TOKEN (or TELEGRAM_BOT_TOKEN fallback)');
  const bot = new Bot(botToken);
  const chatId = await resolveChat(bot, chatGuess);
  console.log(`telegram chat resolved: ${chatId}`);
  if (chatId !== chatCache) {
    await writeFile(`${DIR}.chat`, `${chatId}\n`, { mode: 0o600 });
  }
  const send = async (md: string): Promise<void> => {
    const msg = await bot.api.sendMessage(chatId, convert(md), { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
    console.log(`telegram delivered message_id=${msg.message_id}`);
  };

  const CFG = { ...TON_CONFIG, posSizeSol: PAPER_USD };
  const state = await loadState();
  const stats = (): { closed: number; wins: number; totalPnlSol: number } => ({
    closed: state.closed.length,
    wins: state.closed.filter((c) => c.pnlSol > 0).length,
    totalPnlSol: state.closed.reduce((s, c) => s + c.pnlSol, 0),
  });

  if (state.initializedAtMs === null) {
    const q = await dexQuote(MINT);
    if (!q?.priceUsd) throw new Error('no DexScreener price for mint');
    const now = Date.now();
    const ageH = q.pairCreatedAtMs ? (now - q.pairCreatedAtMs) / 3600_000 : null;
    const est4h = estimatePriceHoursAgo(q.priceUsd, 4, { h1: q.chgH1, h6: q.chgH6, h24: q.chgH24 });
    const mk = (name: 'now' | 'late4h', entry: number, estimated: boolean, note: string): void => {
      const pos = openPosition(CFG, {
        id: `${name}-${now.toString(36)}`,
        mint: MINT,
        symbol: q.symbol,
        wallet: 'tracker',
        walletLabel: name === 'now' ? 'entry-now @market' : `entry-4h-ago ${note}`,
        entryPriceUsd: entry,
        solUsdAtEntry: 1,
        atMs: now,
        balanceBeforeSol: state.balanceUsd,
        buyers24h: q.buys24h ?? 0,
        liqUsd: q.liqUsd,
        mcapUsd: q.mcapUsd,
        ageHours: ageH,
        rugScore: null,
      });
      state.balanceUsd -= CFG.posSizeSol + CFG.feeOpenSol;
      state.scenarios.push({ name, pos, estimatedEntry: estimated, entryNote: note });
    };
    mk('now', q.priceUsd, false, 'live first tick');
    if (est4h !== null) {
      mk('late4h', est4h, true, `est $${est4h.toFixed(5)} from h1/h6/h24`);
    }
    state.initializedAtMs = now;
    await saveState(state);
    await send(startupReport(CFG, 1, state.balanceUsd));
    for (const s of state.scenarios) {
      await send(openReport(CFG, s.pos, state.balanceUsd, null));
    }
    const drift = ((q.priceUsd - (est4h ?? q.priceUsd)) / (est4h ?? q.priceUsd)) * 100;
    await send([
      `📊 **${q.symbol} context @open**`,
      ``,
      `• Price: $${q.priceUsd.toFixed(5)} (${q.dex}) | Liq $${(q.liqUsd ?? 0).toLocaleString()} | MCap $${(q.mcapUsd ?? 0).toLocaleString()} | Vol24 $${(q.vol24Usd ?? 0).toLocaleString()}`,
      `• Move since signal (~4h ago, est): **${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%**`,
      `• Entry-now $25 vs entry-4h-ago $25 — both managed identically from here`,
    ].join('\n'));
  } else {
    await send(startupReport(CFG, 1, state.balanceUsd));
  }
  void 0;
  console.log(`ton-track live: ${SYMBOL}, ${state.scenarios.filter((s) => s.pos.status === 'open').length} open scenarios`);

  for (;;) {
    try {
      const q = await dexQuote(MINT);
      if (q?.priceUsd) {
        const now = Date.now();
        let dirty = false;
        for (const s of state.scenarios) {
          const pos = s.pos;
          if (pos.status !== 'open') continue;
          const ev = tickPosition(CFG, pos, q.priceUsd, now);
          for (const leg of ev.partials) {
            state.balanceUsd += (leg.qtyTokens / pos.qtyTokens) * CFG.posSizeSol * (leg.priceUsd / pos.entryPriceUsd) - CFG.feeLegSol;
            dirty = true;
            await send(partialReport(CFG, pos, leg, null));
          }
          if (ev.closed) {
            const last = pos.legs.at(-1)!;
            state.balanceUsd += (last.qtyTokens / pos.qtyTokens) * CFG.posSizeSol * (last.priceUsd / pos.entryPriceUsd) - CFG.feeLegSol;
            const pnl = positionPnlSol(pos) - CFG.feeOpenSol;
            state.closed.push({ scenario: s.name, symbol: pos.symbol, pnlSol: pnl, win: pnl > 0, atMs: now });
            dirty = true;
            await send(closeReport(CFG, pos, state.balanceUsd, null, stats()));
          }
        }
        if (dirty) await saveState(state);
      }
    } catch (e) {
      console.warn('tick failed', String(e).slice(0, 120));
    }
    await sleep(POLL_MS);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
