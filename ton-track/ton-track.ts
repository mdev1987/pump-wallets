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
  PUMP_CONFIG,
  estimatePriceHoursAgo,
  parseOpenCommand,
  findOpenByMint,
  type DexQuote,
} from './track';
import {
  openPosition,
  tickPosition,
  positionPnlSol,
  legPnlSol,
  openReport,
  partialReport,
  closeReport,
  startupReport,
  type EngineConfig,
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

type ScenarioName = 'now' | 'late4h' | 'pump';

type State = {
  balanceUsd: number;
  scenarios: Array<{ name: ScenarioName; pos: Position; estimatedEntry: boolean; entryNote: string }>;
  closed: Array<{ scenario: string; symbol: string; pnlSol: number; win: boolean; atMs: number }>;
  /** Per-position engine config (pump-catcher vs tracker defaults). */
  cfgs: Record<string, EngineConfig>;
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
    const s = JSON.parse(await readFile(STATE_PATH, 'utf8')) as State;
    s.cfgs ??= {};
    return s;
  } catch {
    return { balanceUsd: START_BANK_USD, scenarios: [], closed: [], cfgs: {}, initializedAtMs: null };
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
  // Legacy RizzGram scenarios predate per-position configs.
  const cfgFor = (id: string): EngineConfig => state.cfgs[id] ?? CFG;
  const stats = (): { closed: number; wins: number; totalPnlSol: number } => ({
    closed: state.closed.length,
    wins: state.closed.filter((c) => c.pnlSol > 0).length,
    totalPnlSol: state.closed.reduce((s, c) => s + c.pnlSol, 0),
  });
  const creditLeg = (pos: Position, cfg: EngineConfig, qty: number, price: number): void => {
    state.balanceUsd += (qty / pos.qtyTokens) * cfg.posSizeSol * (price / pos.entryPriceUsd) - cfg.feeLegSol;
  };

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
      state.cfgs[pos.id] = CFG;
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
  console.log(`ton-track live: ${SYMBOL}, ${state.scenarios.filter((s) => s.pos.status === 'open').length} open scenarios`);

  const priceTick = async (): Promise<void> => {
    const open = state.scenarios.filter((s) => s.pos.status === 'open');
    if (!open.length) return;
    const mints = [...new Set(open.map((s) => s.pos.mint))];
    let quotes = new Map<string, DexQuote>();
    try {
      const data = (await fetchJson(`https://api.dexscreener.com/tokens/v1/ton/${mints.join(',')}`)) as Array<Record<string, unknown>>;
      for (const p of Array.isArray(data) ? data : []) {
        const addr = (p['baseToken'] as Record<string, string>)?.['address'] ?? '';
        const px = p['priceUsd'] === null ? null : Number(p['priceUsd']);
        if (addr && px) quotes.set(addr, { ...(await dexQuote(addr)), priceUsd: px } as DexQuote);
      }
    } catch (e) {
      console.warn('batch price tick failed', String(e).slice(0, 100));
      return;
    }
    // Fall back per-mint on batch gaps.
    for (const s of open) {
      if (!quotes.has(s.pos.mint)) {
        const q = await dexQuote(s.pos.mint).catch(() => null);
        if (q?.priceUsd) quotes.set(s.pos.mint, q);
      }
    }
    const now = Date.now();
    let dirty = false;
    for (const s of open) {
      const pos = s.pos;
      const cfg = cfgFor(pos.id);
      const px = quotes.get(pos.mint)?.priceUsd;
      if (!px) continue;
      const ev = tickPosition(cfg, pos, px, now);
      for (const leg of ev.partials) {
        creditLeg(pos, cfg, leg.qtyTokens, leg.priceUsd);
        dirty = true;
        await send(partialReport(cfg, pos, leg, null));
      }
      if (ev.closed) {
        const last = pos.legs.at(-1)!;
        creditLeg(pos, cfg, last.qtyTokens, last.priceUsd);
        const pnl = positionPnlSol(pos) - cfg.feeOpenSol;
        state.closed.push({ scenario: s.name, symbol: pos.symbol, pnlSol: pnl, win: pnl > 0, atMs: now });
        dirty = true;
        await send(closeReport(cfg, pos, state.balanceUsd, null, stats()));
      }
    }
    if (dirty) await saveState(state);
  };

  /** /close: full manual exit at the live price. */
  const manualClose = async (query: string): Promise<string> => {
    const { found } = findOpenByMint(state.scenarios.map((s) => s.pos), query);
    if (found.length === 0) return `❌ No open position matches \`${query}\`. Use /status to list.`;
    if (found.length > 1) {
      return `❌ Ambiguous prefix — matches ${found.length} positions: ${found.map((p) => `\`${p.mint.slice(0, 12)}…\``).join(', ')}. Paste more of the address.`;
    }
    const pos = found[0]!;
    const cfg = cfgFor(pos.id);
    const q = await dexQuote(pos.mint).catch(() => null);
    if (!q?.priceUsd) return `❌ No live price for \`${pos.mint.slice(0, 12)}…\`, position left open.`;
    const now = Date.now();
    const qty = pos.remainingQty;
    pos.remainingQty = 0;
    pos.status = 'closed';
    pos.closeReason = 'manual /close';
    pos.legs.push({ kind: 'timeout', label: 'manual /close', priceUsd: q.priceUsd, qtyTokens: qty, pnlSol: legPnlSol(cfg, pos, qty, q.priceUsd), atMs: now });
    creditLeg(pos, cfg, qty, q.priceUsd);
    const pnl = positionPnlSol(pos) - cfg.feeOpenSol;
    const sc = state.scenarios.find((s) => s.pos.id === pos.id)!;
    state.closed.push({ scenario: sc.name, symbol: pos.symbol, pnlSol: pnl, win: pnl > 0, atMs: now });
    await saveState(state);
    await send(closeReport(cfg, pos, state.balanceUsd, null, stats()));
    return `✅ Closed $${pos.symbol} at $${q.priceUsd} (${((q.priceUsd / pos.entryPriceUsd - 1) * 100).toFixed(1)}%). Report sent.`;
  };

  /** /open: validate, gate lightly (pump-catching), open, report. */
  const openToken = async (text: string): Promise<string> => {
    const parsed = parseOpenCommand(text, PAPER_USD);
    if (!parsed.ok) return `❌ ${parsed.error}`;
    const openCount = state.scenarios.filter((s) => s.pos.status === 'open').length;
    if (openCount >= 5) return `❌ Too many open positions (${openCount}/5). /close one first.`;
    if (state.scenarios.some((s) => s.pos.status === 'open' && s.pos.mint === parsed.mint)) {
      return `❌ Already tracking \`${parsed.mint.slice(0, 12)}…\`.`;
    }
    const q = await dexQuote(parsed.mint).catch(() => null);
    if (!q?.priceUsd) return `❌ No DexScreener price for that address (wrong chain or unknown token).`;
    if ((q.liqUsd ?? 0) < 2000) return `❌ Liquidity too thin ($${(q.liqUsd ?? 0).toLocaleString()} < $2,000). Refusing.`;
    const sizeUsd = parsed.sizeUsd;
    if (state.balanceUsd < sizeUsd + PUMP_CONFIG.feeOpenSol) return `❌ Paper balance $${state.balanceUsd.toFixed(2)} < $${sizeUsd} + fee.`;
    const cfg = { ...PUMP_CONFIG, posSizeSol: sizeUsd };
    const now = Date.now();
    const pos = openPosition(cfg, {
      id: `pump-${now.toString(36)}`,
      mint: parsed.mint,
      symbol: q.symbol,
      wallet: 'command',
      walletLabel: 'manual /open — pump-catch',
      entryPriceUsd: q.priceUsd,
      solUsdAtEntry: 1,
      atMs: now,
      balanceBeforeSol: state.balanceUsd,
      buyers24h: q.buys24h ?? 0,
      liqUsd: q.liqUsd,
      mcapUsd: q.mcapUsd,
      ageHours: q.pairCreatedAtMs ? (now - q.pairCreatedAtMs) / 3600_000 : null,
      rugScore: null,
    });
    state.balanceUsd -= sizeUsd + cfg.feeOpenSol;
    state.cfgs[pos.id] = cfg;
    state.scenarios.push({ name: 'pump', pos, estimatedEntry: false, entryNote: 'manual /open' });
    await saveState(state);
    await send(openReport(cfg, pos, state.balanceUsd, null));
    return `✅ Tracking $${q.symbol} — pump-catch armed (TP +50%/+300%, trail 30%→20%, 24h). Exits only on TP/trail/timeout/manual.`;
  };

  const statusText = async (): Promise<string> => {
    const open = state.scenarios.filter((s) => s.pos.status === 'open');
    if (!open.length) return `📊 No open positions. Balance $${state.balanceUsd.toFixed(2)}. Use /open <CA> [usd].`;
    const lines = [`📊 **Open (${open.length}) — balance $${state.balanceUsd.toFixed(2)}**`, ``];
    for (const s of open) {
      const q = await dexQuote(s.pos.mint).catch(() => null);
      const cur = q?.priceUsd;
      const ret = cur ? `${((cur / s.pos.entryPriceUsd - 1) * 100).toFixed(1)}%` : 'n/a';
      const ageMs = Date.now() - s.pos.openedAtMs;
      const age = ageMs < 5400_000 ? `${Math.round(ageMs / 60000)}m` : `${(ageMs / 3600_000).toFixed(1)}h`;
      lines.push(`• $${s.pos.symbol} \`${s.pos.mint.slice(0, 10)}…\` entry $${s.pos.entryPriceUsd} → now ${cur ? `$${cur}` : 'n/a'} (**${ret}**, ${age})`);
    }
    const st = stats();
    lines.push(``, `Session: ${st.wins}/${st.closed} wins, ${st.totalPnlSol >= 0 ? '+' : ''}$${st.totalPnlSol.toFixed(2)} total`);
    return lines.join('\n');
  };

  bot.command('open', async (ctx) => {
    try {
      await ctx.reply(convert(await openToken(ctx.message?.text ?? '')), { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
    } catch (e) {
      await ctx.reply(`❌ open failed: ${String(e).slice(0, 200)}`);
    }
  });
  bot.command('close', async (ctx) => {
    try {
      const q = (ctx.message?.text ?? '').split(/\s+/).slice(1).join(' ');
      if (!q) {
        await ctx.reply(convert('Usage: /close <CA or 8+ char prefix>'), { parse_mode: 'MarkdownV2' });
        return;
      }
      await ctx.reply(convert(await manualClose(q)), { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
    } catch (e) {
      await ctx.reply(`❌ close failed: ${String(e).slice(0, 200)}`);
    }
  });
  bot.command('status', async (ctx) => {
    try {
      await ctx.reply(convert(await statusText()), { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
    } catch (e) {
      await ctx.reply(`❌ status failed: ${String(e).slice(0, 200)}`);
    }
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(convert([
      `🤖 **Pump-catch commands**`,
      ``,
      `/open <CA> [usd] — track a TON token ($25 default). Pump plan below.`,
      `/close <CA|prefix> — full manual exit at market.`,
      `/status — open positions with live ret.`,
      ``,
      `Pump plan: TP +100%×20%, +200%×20%, 60% runner. Trailing SL 45% (wide). 24h hold.`,
      `Exits fire only on TP / trailing breach / timeout / manual — never on chop.`,
    ].join('\n')), { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } });
  });
  bot.command('start', async (ctx) => {
    await ctx.reply(convert('👋 Send /help for commands. I track TON tokens with wide pump-catcher paper positions.'), { parse_mode: 'MarkdownV2' });
  });

  process.once('SIGTERM', () => {
    console.log('SIGTERM, stopping Telegram polling');
    void bot.stop().catch(() => undefined);
  });
  console.log('telegram command polling on (/open /close /status /help)');
  const priceLoop = (async (): Promise<void> => {
    for (;;) {
      try {
        await priceTick();
      } catch (e) {
        console.warn('tick failed', String(e).slice(0, 120));
      }
      await sleep(POLL_MS);
    }
  })();
  await Promise.all([bot.start(), priceLoop]);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
