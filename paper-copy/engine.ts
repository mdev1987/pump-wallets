/**
 * Paper copy-trading engine: position lifecycle, ledger and report builders.
 *
 * Pure logic, no network: price ticks go in, exit events and Markdown reports
 * come out. All money math is in SOL; USD figures are display-only.
 */

export type TpRung = {
  /** Take-profit trigger, e.g. 1.0 = +100%. */
  pct: number;
  /** Fraction of the ORIGINAL position sold at this rung, e.g. 0.2. */
  share: number;
};

export type EngineConfig = {
  posSizeSol: number;
  /** Ordered take-profit ladder (shares of original size; remainder rides). */
  tpLadder: TpRung[];
  trailPct: number; // e.g. 0.15 -> trailing stop 15% under peak
  trailTightPct: number; // trailing stop once any TP has filled (locks partials)
  maxHoldSec: number;
  feeOpenSol: number;
  feeLegSol: number;
  /** Display unit for money math (default SOL). TON trackers use USD. */
  unitLabel?: string;
};

export const DEFAULT_CONFIG: EngineConfig = {
  posSizeSol: 0.05,
  tpLadder: [
    { pct: 0.12, share: 0.5 },
    { pct: 0.4, share: 0.5 },
  ],
  trailPct: 0.15,
  trailTightPct: 0.08,
  maxHoldSec: 2400,
  feeOpenSol: 0.0002,
  feeLegSol: 0.0001,
};

export type ExitLeg = {
  kind: 'tp' | 'trail' | 'timeout';
  /** Human leg label, e.g. 'TP +100% (20%)'. */
  label: string;
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
  /** Per-rung fill flags aligned with cfg.tpLadder (self-migrates from tp1Done). */
  tpDone: boolean[];
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
    tpDone: [],
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

/** Realized PnL of selling legQty at price vs entry, in position units. Exported for manual-close flows. */
export function legPnlSol(cfg: EngineConfig, pos: Position, legQty: number, priceUsd: number): number {
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
    // After the first partial, tighten the trail so a +20-30% runner that
    // fades keeps most of the move instead of round-tripping to the wide stop.
    const trail = (pos.tpDone?.some(Boolean) ?? pos.tp1Done) ? cfg.trailTightPct : cfg.trailPct;
    pos.stopPriceUsd = Math.max(pos.stopPriceUsd, priceUsd * (1 - trail));
  }
  const ret = priceUsd / pos.entryPriceUsd - 1;

  // Self-migrate pre-ladder positions (tp1Done era): first rung = old TP1.
  if (pos.tpDone === undefined) pos.tpDone = [!!pos.tp1Done];
  const anyFilled = pos.tpDone.some(Boolean);

  for (let i = 0; i < cfg.tpLadder.length; i += 1) {
    const rung = cfg.tpLadder[i]!;
    if (pos.tpDone[i] || ret < rung.pct || pos.remainingQty <= 0) continue;
    pos.tpDone[i] = true;
    const qty = Math.min(pos.qtyTokens * rung.share, pos.remainingQty);
    pos.remainingQty -= qty;
    // Partial legs join pos.legs immediately: otherwise realized partial PnL
    // is credited to the ledger but invisible to positionPnlSol/close records.
    const leg: ExitLeg = {
      kind: 'tp',
      label: `TP +${(rung.pct * 100).toFixed(0)}% (${(rung.share * 100).toFixed(0)}%)`,
      priceUsd,
      qtyTokens: qty,
      pnlSol: legPnlSol(cfg, pos, qty, priceUsd),
      atMs: nowMs,
    };
    pos.legs.push(leg);
    partials.push(leg);
    // Lock the partial immediately: tighten the stop to the fill price regime.
    pos.stopPriceUsd = Math.max(pos.stopPriceUsd, priceUsd * (1 - cfg.trailTightPct));
  }
  let closed = false;
  let closeReason: string | null = null;
  const closeRest = (kind: ExitLeg['kind'], label: string, reason: string): void => {
    const qty = pos.remainingQty;
    pos.remainingQty = 0;
    pos.status = 'closed';
    pos.closeReason = reason;
    pos.legs.push({ kind, label, priceUsd, qtyTokens: qty, pnlSol: legPnlSol(cfg, pos, qty, priceUsd), atMs: nowMs });
    closed = true;
    closeReason = reason;
  };

  // Ladder exhausted (rung shares sum to ~all): convert the last fill of
  // this tick into the closing leg so its size and PnL are not lost to the
  // emptied remainder. Otherwise the remainder rides as a runner.
  const dust = pos.qtyTokens * 0.001;
  if (pos.remainingQty <= dust && pos.tpDone.some(Boolean)) {
    const lastFill = partials.at(-1);
    const lastIdx = pos.tpDone.lastIndexOf(true);
    const lastRung = cfg.tpLadder[lastIdx];
    const label = lastRung ? `TP +${(lastRung.pct * 100).toFixed(0)}% (ladder complete)` : 'ladder complete';
    if (lastFill) {
      // lastFill is already recorded in pos.legs (same object): relabel it
      // and withhold it from partials so the service credits it once, here.
      partials.pop();
      lastFill.label = label;
      pos.remainingQty = lastFill.qtyTokens;
      pos.status = 'closed';
      pos.closeReason = label;
      closed = true;
      closeReason = label;
    } else {
      closeRest('tp', label, label);
    }
  } else if (pos.remainingQty > 0) {
    if (priceUsd <= pos.stopPriceUsd) {
      closeRest('trail', 'trailing stop', `trailing stop (${(cfg.trailPct * 100).toFixed(0)}% under peak)`);
    } else if (cfg.maxHoldSec > 0 && nowMs - pos.openedAtMs >= cfg.maxHoldSec * 1000) {
      closeRest('timeout', 'timeout', `max hold ${(cfg.maxHoldSec / 60).toFixed(0)}m`);
    }
  }
  return { partials, closed, closeReason };
}

export function positionPnlSol(pos: Position): number {
  return pos.legs.reduce((s, l) => s + l.pnlSol, 0);
}

export type RugAssessment = { veto: boolean; reason: string; score: number | null };

/**
 * RugCheck gate on the NORMALIZED 0-100 scale. Meme tokens routinely score
 * 50-75 on low-liquidity warnings alone, so a flat `score > 50` veto blocks
 * every entry in this market. Veto only on explicit danger findings (or an
 * extreme score); everything else passes with its score logged for review.
 */
export function assessRug(summary: unknown): RugAssessment {
  if (!summary || typeof summary !== 'object') {
    return { veto: false, reason: 'unavailable (warn-only)', score: null };
  }
  const d = summary as Record<string, unknown>;
  const score = typeof d['score_normalised'] === 'number' ? (d['score_normalised'] as number) : null;
  const risks = Array.isArray(d['risks']) ? (d['risks'] as Array<Record<string, unknown>>) : [];
  const dangers = risks.filter((r) => r['level'] === 'danger').map((r) => String(r['name'] ?? 'unnamed'));
  if (dangers.length > 0) {
    return { veto: true, reason: `danger: ${dangers.slice(0, 3).join(', ')}`, score };
  }
  if (score !== null && score >= 85) {
    return { veto: true, reason: `extreme score ${score}`, score };
  }
  return { veto: false, reason: score === null ? 'unscored (warn-only)' : `score ${score}, no danger findings`, score };
}

export function unitOf(cfg: EngineConfig): string {
  return cfg.unitLabel ?? 'SOL';
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
  if (s < 5400) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

/** 🟢 Open-position alert body (standard Markdown, converted at send time). */
export function openReport(cfg: EngineConfig, pos: Position, balanceAfterSol: number, solUsd: number | null): string {
  const valUsd = cfg.posSizeSol * (solUsd ?? pos.solUsdAtEntry);
  return [
    `🟢 **PAPER OPEN** — $${pos.symbol} (${pos.mint.slice(0, 8)}…)`,
    ``,
    `👛 Wallet: \`${pos.walletLabel}\` (\`${pos.wallet.slice(0, 8)}…\`)`,
    `💰 Entry: ${fmtUsd(pos.entryPriceUsd)} | Size: **${cfg.posSizeSol} ${unitOf(cfg)}** (~${fmtUsd(valUsd)})`,
    `👥 Tracked buyers (24h): **${pos.buyers24h}**`,
    ``,
    `🛡️ **Risk plan**`,
    ...cfg.tpLadder.map((r, i) => `• 🎯 TP${i + 1}: +${(r.pct * 100).toFixed(0)}% sell ${(r.share * 100).toFixed(0)}%`),
    `• 📉 Trailing SL: ${(cfg.trailPct * 100).toFixed(0)}% under peak (starts ${fmtUsd(pos.stopPriceUsd)})`,
    `• ⏱️ Max hold: ${cfg.maxHoldSec <= 0 ? 'off' : cfg.maxHoldSec >= 3600 ? `${(cfg.maxHoldSec / 3600).toFixed(cfg.maxHoldSec % 3600 === 0 ? 0 : 1)}h` : `${(cfg.maxHoldSec / 60).toFixed(0)}m`}`,
    ``,
    `📊 **Token checks**`,
    `• Liquidity: ${fmtUsd(pos.liqUsd)} | MCap: ${fmtUsd(pos.mcapUsd)} | Age: ${ageStr(pos.ageHours)}`,
    `• RugCheck score: ${pos.rugScore === null ? 'n/a (warn-only)' : pos.rugScore}`,
    ``,
    `💼 Balance before: ${pos.balanceBeforeSol.toFixed(4)} ${unitOf(cfg)} → after: ${balanceAfterSol.toFixed(4)} ${unitOf(cfg)}`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🔔 Partial take-profit update. */
export function partialReport(cfg: EngineConfig, pos: Position, leg: ExitLeg, solUsd: number | null): string {
  const usd = solUsd ? ` (~${fmtUsd(leg.pnlSol * solUsd)})` : '';
  return [
    `🔔 **PARTIAL TP** — $${pos.symbol}`,
    ``,
    `• Sold ${(leg.qtyTokens / pos.qtyTokens * 100).toFixed(0)}% at ${fmtUsd(leg.priceUsd)} (${fmtPct(leg.priceUsd / pos.entryPriceUsd - 1)})`,
    `• Realized: **${leg.pnlSol >= 0 ? '+' : ''}${leg.pnlSol.toFixed(5)} ${unitOf(cfg)}**${usd}`,
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
  const U = cfg.unitLabel ?? 'SOL';
  const winrate = stats.closed > 0 ? `${((stats.wins / stats.closed) * 100).toFixed(1)}% (${stats.wins}/${stats.closed})` : 'n/a';
  const usd = solUsd ? ` (~${fmtUsd(pnl * solUsd)})` : '';
  const legs = pos.legs
    .map((l) => `• ${l.label}: ${fmtUsd(l.priceUsd)} (${fmtPct(l.priceUsd / pos.entryPriceUsd - 1)}) → ${l.pnlSol >= 0 ? '+' : ''}${l.pnlSol.toFixed(5)} ${unitOf(cfg)}`)
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
    `💰 **Position PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} ${unitOf(cfg)}**${usd}`,
    `💼 Balance: ${pos.balanceBeforeSol.toFixed(4)} → **${balanceAfterSol.toFixed(4)} ${unitOf(cfg)}**`,
    ``,
    `📊 **Session**: winrate ${winrate} | total ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} ${unitOf(cfg)} over ${stats.closed} closed`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🚀 Startup card proving the service, config and Telegram path are live. */
export function startupReport(cfg: EngineConfig, tracked: number, balanceSol: number): string {
  return [
    `🚀 **Paper-copy reporter live**`,
    ``,
    `👀 Tracking **${tracked}** leader wallets (5-min sweep)`,
    `💰 Size **${cfg.posSizeSol} ${cfg.unitLabel ?? 'SOL'}**/pos | TP ${cfg.tpLadder.map((r) => `+${(r.pct * 100).toFixed(0)}%×${(r.share * 100).toFixed(0)}%`).join(' ')} | Trail ${(cfg.trailPct * 100).toFixed(0)}% | Hold ${cfg.maxHoldSec <= 0 ? 'off' : `≤${(cfg.maxHoldSec / 3600).toFixed(1)}h`}`,
    `💼 Paper balance: **${balanceSol.toFixed(4)} ${cfg.unitLabel ?? 'SOL'}**`,
    `📝 Reports: open / partial-TP / close with PnL, winrate, balances`,
  ].join('\n');
}
