/**
 * Paper copy-trading engine: position lifecycle, ledger and report builders.
 *
 * Pure logic, no network: price ticks go in, exit events and Markdown reports
 * come out. All money math is in SOL; USD figures are display-only.
 */

export type EngineConfig = {
  posSizeSol: number;
  tp1Pct: number; // e.g. 0.25 -> sell tp1Share at +25%
  tp1Share: number; // e.g. 0.5
  tp2Pct: number; // e.g. 0.5 -> sell rest at +50%
  trailPct: number; // e.g. 0.15 -> trailing stop 15% under peak
  maxHoldSec: number;
  feeOpenSol: number;
  feeLegSol: number;
};

export const DEFAULT_CONFIG: EngineConfig = {
  posSizeSol: 0.05,
  tp1Pct: 0.25,
  tp1Share: 0.5,
  tp2Pct: 0.5,
  trailPct: 0.15,
  maxHoldSec: 2400,
  feeOpenSol: 0.0002,
  feeLegSol: 0.0001,
};

export type ExitLeg = {
  kind: 'tp1' | 'tp2' | 'trail' | 'timeout';
  priceUsd: number;
  qtyTokens: number;
  pnlSol: number;
  atMs: number;
};

export type Position = {
  id: string;
  mint: string;
  symbol: string;
  wallet: string;
  walletLabel: string;
  entryPriceUsd: number;
  solUsdAtEntry: number;
  qtyTokens: number;
  remainingQty: number;
  peakPriceUsd: number;
  stopPriceUsd: number;
  tp1Done: boolean;
  openedAtMs: number;
  balanceBeforeSol: number;
  legs: ExitLeg[];
  status: 'open' | 'closed';
  closeReason: string | null;
  buyers24h: number;
  liqUsd: number | null;
  mcapUsd: number | null;
  ageHours: number | null;
  rugScore: number | null;
};

export type TickEvents = {
  partials: ExitLeg[];
  closed: boolean;
  closeReason: string | null;
};

export function openPosition(
  cfg: EngineConfig,
  args: {
    id: string;
    mint: string;
    symbol: string;
    wallet: string;
    walletLabel: string;
    entryPriceUsd: number;
    solUsdAtEntry: number;
    atMs: number;
    balanceBeforeSol: number;
    buyers24h: number;
    liqUsd: number | null;
    mcapUsd: number | null;
    ageHours: number | null;
    rugScore: number | null;
  },
): Position {
  const qtyTokens = (cfg.posSizeSol * args.solUsdAtEntry) / args.entryPriceUsd;
  const { atMs, ...rest } = args;
  return {
    ...rest,
    openedAtMs: atMs,
    qtyTokens,
    remainingQty: qtyTokens,
    peakPriceUsd: args.entryPriceUsd,
    stopPriceUsd: args.entryPriceUsd * (1 - cfg.trailPct),
    tp1Done: false,
    legs: [],
    status: 'open',
    closeReason: null,
  };
}

/** Realized PnL of selling legQty at price vs entry, in SOL terms. */
function legPnlSol(cfg: EngineConfig, pos: Position, legQty: number, priceUsd: number): number {
  const entryCostShare = (legQty / pos.qtyTokens) * cfg.posSizeSol;
  const proceedsShare = (legQty / pos.qtyTokens) * cfg.posSizeSol * (priceUsd / pos.entryPriceUsd);
  return proceedsShare - entryCostShare - cfg.feeLegSol;
}

/**
 * Advance a position with a fresh price. Returns partial-fill legs plus an
 * optional full close. Priority per tick: TP2 > trailing stop > timeout.
 * TP1 is a partial event and never closes the position by itself.
 */
export function tickPosition(cfg: EngineConfig, pos: Position, priceUsd: number, nowMs: number): TickEvents {
  const partials: ExitLeg[] = [];
  if (pos.status !== 'open' || !(priceUsd > 0)) return { partials, closed: false, closeReason: null };
  if (priceUsd > pos.peakPriceUsd) {
    pos.peakPriceUsd = priceUsd;
    pos.stopPriceUsd = Math.max(pos.stopPriceUsd, priceUsd * (1 - cfg.trailPct));
  }
  const ret = priceUsd / pos.entryPriceUsd - 1;

  if (!pos.tp1Done && ret >= cfg.tp1Pct) {
    pos.tp1Done = true;
    const qty = pos.remainingQty * cfg.tp1Share;
    pos.remainingQty -= qty;
    partials.push({ kind: 'tp1', priceUsd, qtyTokens: qty, pnlSol: legPnlSol(cfg, pos, qty, priceUsd), atMs: nowMs });
  }

  let closed = false;
  let closeReason: string | null = null;
  const closeRest = (kind: ExitLeg['kind'], reason: string): void => {
    const qty = pos.remainingQty;
    pos.remainingQty = 0;
    pos.status = 'closed';
    pos.closeReason = reason;
    pos.legs.push({ kind, priceUsd, qtyTokens: qty, pnlSol: legPnlSol(cfg, pos, qty, priceUsd), atMs: nowMs });
    closed = true;
    closeReason = reason;
  };

  if (ret >= cfg.tp2Pct && pos.remainingQty > 0) closeRest('tp2', `TP2 +${(cfg.tp2Pct * 100).toFixed(0)}%`);
  else if (priceUsd <= pos.stopPriceUsd && pos.remainingQty > 0) {
    closeRest('trail', `trailing stop (${(cfg.trailPct * 100).toFixed(0)}% under peak)`);
  } else if (nowMs - pos.openedAtMs >= cfg.maxHoldSec * 1000 && pos.remainingQty > 0) {
    closeRest('timeout', `max hold ${(cfg.maxHoldSec / 60).toFixed(0)}m`);
  }
  return { partials, closed, closeReason };
}

export function positionPnlSol(pos: Position): number {
  return pos.legs.reduce((s, l) => s + l.pnlSol, 0);
}

export function fmtUsd(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return 'n/a';
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.01) return `$${v.toExponential(1)}`;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 4 : 2 })}`;
}

export function fmtPct(v: number): string {
  const s = (v * 100).toFixed(1);
  return `${v >= 0 ? '+' : ''}${s}%`;
}

function ageStr(h: number | null): string {
  if (h === null) return 'n/a';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function durStr(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 🟢 Open-position alert body (standard Markdown, converted at send time). */
export function openReport(cfg: EngineConfig, pos: Position, balanceAfterSol: number, solUsd: number | null): string {
  const valUsd = cfg.posSizeSol * (solUsd ?? pos.solUsdAtEntry);
  return [
    `🟢 **PAPER OPEN** — $${pos.symbol} (${pos.mint.slice(0, 8)}…)`,
    ``,
    `👛 Wallet: \`${pos.walletLabel}\` (\`${pos.wallet.slice(0, 8)}…\`)`,
    `💰 Entry: ${fmtUsd(pos.entryPriceUsd)} | Size: **${cfg.posSizeSol} SOL** (~${fmtUsd(valUsd)})`,
    `👥 Tracked buyers (24h): **${pos.buyers24h}**`,
    ``,
    `🛡️ **Risk plan**`,
    `• 🎯 TP1: +${(cfg.tp1Pct * 100).toFixed(0)}% sell ${(cfg.tp1Share * 100).toFixed(0)}%`,
    `• 🎯 TP2: +${(cfg.tp2Pct * 100).toFixed(0)}% sell rest`,
    `• 📉 Trailing SL: ${(cfg.trailPct * 100).toFixed(0)}% under peak (starts ${fmtUsd(pos.stopPriceUsd)})`,
    `• ⏱️ Max hold: ${(cfg.maxHoldSec / 60).toFixed(0)}m`,
    ``,
    `📊 **Token checks**`,
    `• Liquidity: ${fmtUsd(pos.liqUsd)} | MCap: ${fmtUsd(pos.mcapUsd)} | Age: ${ageStr(pos.ageHours)}`,
    `• RugCheck score: ${pos.rugScore === null ? 'n/a (warn-only)' : pos.rugScore}`,
    ``,
    `💼 Balance before: ${pos.balanceBeforeSol.toFixed(4)} SOL → after: ${balanceAfterSol.toFixed(4)} SOL`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🔔 Partial take-profit update. */
export function partialReport(pos: Position, leg: ExitLeg, solUsd: number | null): string {
  const usd = solUsd ? ` (~${fmtUsd(leg.pnlSol * solUsd)})` : '';
  return [
    `🔔 **PARTIAL TP** — $${pos.symbol}`,
    ``,
    `• Sold 50% at ${fmtUsd(leg.priceUsd)} (${fmtPct(leg.priceUsd / pos.entryPriceUsd - 1)})`,
    `• Realized: **${leg.pnlSol >= 0 ? '+' : ''}${leg.pnlSol.toFixed(5)} SOL**${usd}`,
    `• Runner left: ${(pos.remainingQty).toFixed(2)} tokens | stop now ${fmtUsd(pos.stopPriceUsd)}`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🔴 Close-position alert body with full stats. */
export function closeReport(
  cfg: EngineConfig,
  pos: Position,
  balanceAfterSol: number,
  solUsd: number | null,
  stats: { closed: number; wins: number; totalPnlSol: number },
): string {
  const pnl = positionPnlSol(pos) - cfg.feeOpenSol;
  const icon = pnl >= 0 ? '🟢' : '🔴';
  const winrate = stats.closed > 0 ? `${((stats.wins / stats.closed) * 100).toFixed(1)}% (${stats.wins}/${stats.closed})` : 'n/a';
  const usd = solUsd ? ` (~${fmtUsd(pnl * solUsd)})` : '';
  const legs = pos.legs
    .map((l) => `• ${l.kind.toUpperCase()}: ${fmtUsd(l.priceUsd)} (${fmtPct(l.priceUsd / pos.entryPriceUsd - 1)}) → ${l.pnlSol >= 0 ? '+' : ''}${l.pnlSol.toFixed(5)} SOL`)
    .join('\n');
  return [
    `${icon} **PAPER CLOSE** — $${pos.symbol} — ${pos.closeReason}`,
    ``,
    `👛 Wallet: \`${pos.walletLabel}\``,
    `💰 Entry: ${fmtUsd(pos.entryPriceUsd)} | Exit: ${fmtUsd(pos.legs.at(-1)?.priceUsd ?? NaN)}`,
    `⏱️ Duration: ${durStr((pos.legs.at(-1)?.atMs ?? pos.openedAtMs) - pos.openedAtMs)}`,
    `👥 Tracked buyers (24h): **${pos.buyers24h}**`,
    ``,
    `📜 **Legs**`,
    legs,
    ``,
    `💰 **Position PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} SOL**${usd}`,
    `💼 Balance: ${pos.balanceBeforeSol.toFixed(4)} → **${balanceAfterSol.toFixed(4)} SOL**`,
    ``,
    `📊 **Session**: winrate ${winrate} | total ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} SOL over ${stats.closed} closed`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🚀 Startup card proving the service, config and Telegram path are live. */
export function startupReport(cfg: EngineConfig, tracked: number, balanceSol: number): string {
  return [
    `🚀 **Paper-copy reporter live**`,
    ``,
    `👀 Tracking **${tracked}** leader wallets (5-min sweep)`,
    `💰 Size **${cfg.posSizeSol} SOL**/pos | TP +${(cfg.tp1Pct * 100).toFixed(0)}%/½ +${(cfg.tp2Pct * 100).toFixed(0)}% | Trail ${(cfg.trailPct * 100).toFixed(0)}% | Hold ≤${(cfg.maxHoldSec / 60).toFixed(0)}m`,
    `💼 Paper balance: **${balanceSol.toFixed(4)} SOL**`,
    `📝 Reports: open / partial-TP / close with PnL, winrate, balances`,
  ].join('\n');
}
