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
  /** Original token qty at open — share of sizeSol must use this, not shrinking qtyTokens. */
  openQty: number;
  /** Reserved SOL still locked in this position (cost-basis share of sizeSol). */
  reservedSol: number;
  /** Leader's buy timestamp (ms) when we saw it — for lead-latency stats. */
  leaderBuyTs?: number;
  peakPriceUsd: number;
  /** Stop price for trailing SL */
  stopPriceUsd: number;
  tp1Done: boolean;
  /** Per-rung fill flags aligned with cfg.tpLadder (self-migrates from tp1Done). */
  tpDone: boolean[];
  /** Notional snapshot at open so later config changes can't rewrite history. */
  sizeSol: number;
  /** Fee paid on open */
  feeOpenSol: number;
  feeLegSol: number;
  openedAtMs: number;
  balanceBeforeSol: number;
  /** Accounting fields for new ledger model */
  cashBeforeSol: number;
  cashAfterSol: number;
  reservedAfterSol: number;
  /** Total PnL including fees */
  pnlSol: number;
  legs: ExitLeg[];
  status: 'open' | 'closed';
  closeReason: string | null;
  buyers24h: number;
  liqUsd: number | null;
  mcapUsd: number | null;
  ageHours: number | null;
  rugScore: number | null;
  /** Unrealized PnL on current open position (SOL) */
  unrealizedPnlSol: number;
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
    leaderBuyTs?: number;
  },
): Position {
  const qtyTokens = (cfg.posSizeSol * args.solUsdAtEntry) / args.entryPriceUsd;
  const { atMs, ...rest } = args;
  // Reserved holds position cost basis only. Open fee leaves cash immediately
  // and is booked as realized cost at open (see service open path) so
  // cash+reserved = START + realized holds through partials.
  const reservedSol = cfg.posSizeSol;
  return {
    ...rest,
    openedAtMs: args.atMs,
    tpDone: [],
    sizeSol: cfg.posSizeSol,
    feeOpenSol: cfg.feeOpenSol,
    feeLegSol: cfg.feeLegSol,
    qtyTokens,
    remainingQty: qtyTokens,
    openQty: qtyTokens,
    reservedSol,
    peakPriceUsd: args.entryPriceUsd,
    stopPriceUsd: args.entryPriceUsd * (1 - cfg.trailPct),
    tp1Done: false,
    legs: [],
    status: 'open',
    closeReason: null,
    buyers24h: args.buyers24h,
    liqUsd: args.liqUsd,
    mcapUsd: args.mcapUsd,
    ageHours: args.ageHours,
    rugScore: args.rugScore,
    unrealizedPnlSol: 0,
    pnlSol: 0,
    cashBeforeSol: args.balanceBeforeSol,
    cashAfterSol: args.balanceBeforeSol - cfg.posSizeSol - cfg.feeOpenSol,
    reservedAfterSol: reservedSol,
    leaderBuyTs: args.leaderBuyTs,
  };
}

/**
 * Recalculate unrealized PnL for a position given current price.
 * Returns the unrealized PnL in SOL.
 */
export function unrealizedPnlSol(pos: Position, currentPriceUsd: number): number {
  const qty = pos.remainingQty ?? pos.qtyTokens;
  if (pos.status !== 'open' || !(qty > 0)) return 0;
  const openQty = pos.openQty || pos.qtyTokens || 1;
  const sizeSol = pos.sizeSol ?? 0;
  const costBasis = (qty / openQty) * sizeSol;
  const currentValue = (qty * currentPriceUsd) / pos.solUsdAtEntry;
  return currentValue - costBasis;
}

/** Realized PnL of selling legQty at price vs entry, in position units. Exported for manual-close flows. */
export function legPnlSol(cfg: EngineConfig, pos: Position, legQty: number, priceUsd: number): number {
  const openQty = pos.openQty || pos.qtyTokens || 1;
  const sizeSol = pos.sizeSol ?? cfg.posSizeSol;
  const feeLeg = pos.feeLegSol ?? cfg.feeLegSol;
  const entryCostShare = (legQty / openQty) * sizeSol;
  const proceedsShare = entryCostShare * (priceUsd / pos.entryPriceUsd);
  return proceedsShare - entryCostShare - feeLeg;
}

/** SOL proceeds credited to cash for selling legQty (before leg fee). */
export function legProceedsSol(pos: Position, legQty: number, priceUsd: number): number {
  const openQty = pos.openQty || pos.qtyTokens || 1;
  const sizeSol = pos.sizeSol ?? 0;
  return (legQty / openQty) * sizeSol * (priceUsd / pos.entryPriceUsd);
}

/** Reserved SOL released by selling legQty (cost-basis share of size only). */
export function legReservedReleaseSol(pos: Position, legQty: number): number {
  const openQty = pos.openQty || pos.qtyTokens || 1;
  const sizeSol = pos.sizeSol ?? 0;
  const stillLocked = pos.reservedSol ?? sizeSol;
  const release = (legQty / openQty) * sizeSol;
  return Math.min(Math.max(release, 0), Math.max(stillLocked, 0));
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

  for (let i = 0; i < cfg.tpLadder.length; i += 1) {
    const rung = cfg.tpLadder[i]!;
    if (pos.tpDone[i] || ret < rung.pct || pos.remainingQty <= 0) continue;
    pos.tpDone[i] = true;
    const openQty = pos.openQty || pos.qtyTokens || 1;
    const qty = Math.min(openQty * rung.share, pos.remainingQty);
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
    // Zero-qty closes (dust already swept) record no leg: avoids a phantom -feeLeg.
    if (qty > 0) {
      pos.legs.push({ kind, label, priceUsd, qtyTokens: qty, pnlSol: legPnlSol(cfg, pos, qty, priceUsd), atMs: nowMs });
    }
    closed = true;
    closeReason = reason;
  };

  // Ladder exhausted (rung shares sum to ~all): convert the last fill of
  // this tick into the closing leg so its size and PnL are not lost to the
  // emptied remainder. Otherwise the remainder rides as a runner.
  const dust = (pos.openQty || pos.qtyTokens || 0) * 0.001;
  if (pos.remainingQty <= dust && pos.tpDone.some(Boolean)) {
    const lastFill = partials.at(-1);
    const lastIdx = pos.tpDone.lastIndexOf(true);
    const lastRung = cfg.tpLadder[lastIdx];
    const label = lastRung ? `TP +${(lastRung.pct * 100).toFixed(0)}% (ladder complete)` : 'ladder complete';
    if (lastFill) {
      // lastFill is already recorded in pos.legs (same object): relabel it
      // and withhold it from partials so the service credits it once, here.
      partials.pop();
      const dustRemainder = pos.remainingQty;
      lastFill.label = label;
      if (dustRemainder > 0) {
        // Fold sub-0.1% dust into the final fill so every token is credited
        // exactly once (single leg fee for the combined fill).
        lastFill.qtyTokens += dustRemainder;
        lastFill.pnlSol = legPnlSol(cfg, pos, lastFill.qtyTokens, priceUsd);
      }
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

/** UTC day key for per-wallet daily budgeting. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Signatures-delta for the two-tier sweep: given newest-first signatures and
 * the cursor, how many are fresh. Boot (null cursor) marks position without
 * backfilling; a cursor missing from the window means the gap exceeds it.
 */
export function sigsDelta(sigs: string[], lastSig: string | null): { fresh: number; newest: string | null } {
  if (!sigs.length) return { fresh: 0, newest: lastSig };
  const newest = sigs[0]!;
  if (lastSig === null) return { fresh: 0, newest };
  const idx = sigs.indexOf(lastSig);
  if (idx === -1) return { fresh: sigs.length, newest };
  return { fresh: idx, newest };
}

/**
 * Momentum-chase veto: with minutes of copy latency behind the leader, buying
 * into an already-vertical 5-minute print means buying their top. Skip entries
 * already up more than maxPct in the last 5 minutes; null/unknown passes.
 */
export function momentumBlocked(m5ChangePct: number | null, maxPct = 20): boolean {
  return m5ChangePct !== null && Number.isFinite(m5ChangePct) && m5ChangePct > maxPct;
}

export type DailyBudget = Record<string, { day: string; count: number }>;

/** Per-wallet daily open budget check (diversifies flow across leaders). */
export function walletDayAllowed(budget: DailyBudget, wallet: string, nowMs: number, max: number): boolean {
  const entry = budget[wallet];
  if (!entry || entry.day !== dayKey(nowMs)) return true;
  return entry.count < max;
}

/** Record one open against the wallet's daily budget. */
export function walletDayRecord(budget: DailyBudget, wallet: string, nowMs: number): void {
  const entry = budget[wallet];
  if (!entry || entry.day !== dayKey(nowMs)) {
    budget[wallet] = { day: dayKey(nowMs), count: 1 };
  } else {
    entry.count += 1;
  }
}

/**
 * Ledger self-audit: recompute lifetime PnL from persisted legs and compare
 * against the running balance. Returns a human-readable problem or null.
 * Catches accounting regressions (e.g. credited-but-unrecorded legs) early.
 */
export type LedgerPosition = {
  qtyTokens: number;
  entryPriceUsd: number;
  sizeSol?: number;
  feeOpenSol?: number;
  feeLegSol?: number;
  openQty?: number;
  legs: Array<{ qtyTokens: number; priceUsd: number; pnlSol: number }>;
};

/** Normalize a chain timestamp to ms (Helius Enhanced uses seconds). */
export function asMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

/** Max-mcap gate: unknown mcap passes (DexScreener gaps must not block flow). */
export function mcapBlocked(mcapUsd: number | null, max: number): boolean {
  return assessMcap(mcapUsd, max) === 'over-cap';
}

/**
 * Mcap gate verdict. Prints above `implausibleUsd` (default $1B) are treated
 * as bad vendor data, not real mega-caps: a pump-fun meme at $74B is a
 * misread field, and vetoing on it silently over-filters the funnel.
 */
export function assessMcap(
  mcapUsd: number | null,
  max: number,
  implausibleUsd = 1_000_000_000,
): 'ok' | 'over-cap' | 'bad-data' {
  if (mcapUsd === null || !Number.isFinite(mcapUsd)) return 'ok';
  if (mcapUsd > implausibleUsd) return 'bad-data';
  return mcapUsd > max ? 'over-cap' : 'ok';
}

/** Adaptive toxic-wallet filter: n>=5 closed and negative expectancy. */
export const WALLET_TOXIC_MIN_TRADES = 5;
export const WALLET_TOXIC_MAX_EXPECTANCY = -0.001; // SOL per trade

export function walletTradeStats(
  closed: Array<{ wallet?: string; pnlSol: number }>,
  wallet: string,
  opts?: { lastN?: number },
): { n: number; wins: number; totalPnlSol: number; expectancySol: number } {
  // Windowed to the most recent lastN closes: old sins roll off, so a wallet
  // can redeem itself (and a formerly-good wallet that decayed gets caught).
  const ts = closed.filter((c) => c.wallet === wallet);
  const windowed = opts?.lastN != null ? ts.slice(-opts.lastN) : ts;
  const total = windowed.reduce((sum, c) => sum + (c.pnlSol || 0), 0);
  return {
    n: windowed.length,
    wins: windowed.filter((c) => c.pnlSol > 0).length,
    totalPnlSol: total,
    expectancySol: windowed.length ? total / windowed.length : 0,
  };
}

export function walletToxic(
  closed: Array<{ wallet?: string; pnlSol: number }>,
  wallet: string,
  lastN = 20,
): boolean {
  const st = walletTradeStats(closed, wallet, { lastN });
  return st.n >= WALLET_TOXIC_MIN_TRADES && st.expectancySol < WALLET_TOXIC_MAX_EXPECTANCY;
}

/**
 * Independently recompute cash from persisted legs (no shared helpers, so a
 * formula bug in the credit path cannot hide behind the same formula here).
 * expected = start - Σ(size+feeOpen) + Σ(share*size*price/entry - feeLeg).
 * NaN when any leg/position value is non-finite.
 */
/**
 * Expected cash under the cash/reserved/realized equity model:
 *   cash + reserved = startBalance + realized
 * so expected cash = start + realized - reserved.
 * positions are accepted for signature compatibility but not required.
 */
export function expectedCashFromLegs(
  args: {
    startBalance: number;
    positions: LedgerPosition[];
    posSize: number;
    feeOpen: number;
    feeLeg: number;
  },
): number {
  let expected = args.startBalance;
  for (const p of args.positions) {
    const size = p.sizeSol ?? args.posSize;
    const feeO = p.feeOpenSol ?? args.feeOpen;
    const feeL = p.feeLegSol ?? args.feeLeg;
    const openQty = p.openQty ?? p.qtyTokens;
    if (![size, feeO, feeL, openQty, p.entryPriceUsd].every(Number.isFinite)) return NaN;
    if (!(p.entryPriceUsd > 0) || !(openQty > 0)) return NaN;
    expected -= size + feeO;
    for (const l of p.legs) {
      if (![l.qtyTokens, l.priceUsd].every(Number.isFinite)) return NaN;
      expected += (l.qtyTokens / openQty) * size * (l.priceUsd / p.entryPriceUsd) - feeL;
    }
  }
  return expected;
}

export function ledgerExpected(
  args: {
    startBalance: number;
    positions: LedgerPosition[];
    posSize: number;
    feeOpen: number;
    feeLeg: number;
    realized?: number;
    reserved?: number;
  },
): number {
  const realized = args.realized ?? 0;
  const reserved = args.reserved ?? 0;
  if (!Number.isFinite(realized) || !Number.isFinite(reserved)) return NaN;
  return args.startBalance + realized - reserved;
}

/**
 * Equity audit for the cash/reserved model:
 *   | (cash + reserved) - (start + realized) | <= tol
 * legacyOffset anchors pre-migration books once.
 */
export function auditLedger(args: {
  startBalance: number;
  balance: number;
  positions: LedgerPosition[];
  posSize: number;
  feeOpen: number;
  feeLeg: number;
  realized?: number;
  reserved?: number;
  legacyOffset?: number;
  /** Actual cash for the independent legs-based check; omit to skip it. */
  cash?: number;
  /** One-time anchor for pre-audit cash history (same pattern as legacyOffset). */
  cashOffset?: number;
  cashTol?: number;
}): string | null {
  if (!Number.isFinite(args.balance) || args.balance < 0 || args.balance > args.startBalance * 10) {
    return `balance out of range: ${args.balance}`;
  }
  const reserved = args.reserved ?? 0;
  const realized = args.realized ?? 0;
  if (!Number.isFinite(reserved) || reserved < -1e-9) {
    return `reserved out of range: ${reserved}`;
  }
  if (Number.isFinite(reserved) && reserved > 10 * args.posSize + 1e-9) {
    return `reserved implausible: ${reserved} (cap ${10 * args.posSize})`;
  }
  if (!Number.isFinite(realized)) return 'non-finite realized pnl';
  const equityLedger = args.balance + Math.max(reserved, 0);
  const equityExpected = args.startBalance + realized + (args.legacyOffset ?? 0);
  if (Math.abs(equityLedger - equityExpected) > 0.001) {
    return `equity drift: cash+reserved ${equityLedger.toFixed(4)} vs start+realized ${equityExpected.toFixed(4)}`;
  }
  if (args.cash !== undefined) {
    const recomputed = expectedCashFromLegs(args);
    if (Number.isFinite(recomputed)) {
      const tol = args.cashTol ?? 0.01;
      if (Math.abs(args.cash - (recomputed + (args.cashOffset ?? 0))) > tol) {
        return `cash drift: ledger ${args.cash.toFixed(4)} vs legs-recomputed ${(recomputed + (args.cashOffset ?? 0)).toFixed(4)}`;
      }
    }
  }
  return null;
}

/** Lead-latency buckets: does entering later after the leader buy lose money? */
export type LeadBucket = { label: string; n: number; wins: number; totalPnlSol: number; winRate: number };

export function leadBuckets(
  trades: Array<{ leadMs: number | null; pnlSol: number; win: boolean }>,
): LeadBucket[] {
  const defs: Array<{ label: string; test: (ms: number) => boolean }> = [
    { label: '<2m', test: (ms) => ms < 120_000 },
    { label: '2-4m', test: (ms) => ms < 240_000 },
    { label: '>=4m', test: () => true },
  ];
  const out: LeadBucket[] = defs.map((d) => ({ label: d.label, n: 0, wins: 0, totalPnlSol: 0, winRate: 0 }));
  for (const t of trades) {
    if (t.leadMs == null || !Number.isFinite(t.leadMs)) continue;
    const b = out.find((_, i) => defs[i]!.test(t.leadMs!))!;
    b.n += 1;
    if (t.win) b.wins += 1;
    b.totalPnlSol += t.pnlSol;
  }
  for (const b of out) b.winRate = b.n ? b.wins / b.n : 0;
  return out;
}

/** Balances mutated by settlement; the position carries the rest. */
export type LedgerBalances = { cashSol: number; reservedSol: number; realizedPnlSol: number };

/**
 * Settle one exit leg against the ledger. Pure except for mutating its
 * arguments — the single place partials and closes touch money, so the
 * invariant cash+reserved == START+realized holds by construction.
 * Engine already reduced remainingQty; qtyTokens is synced to it.
 */
export function settlePartial(
  cfg: EngineConfig,
  ledger: LedgerBalances,
  pos: Position,
  leg: ExitLeg,
): void {
  const feeLeg = pos.feeLegSol ?? cfg.feeLegSol;
  ledger.cashSol += legProceedsSol(pos, leg.qtyTokens, leg.priceUsd) - feeLeg;
  const release = legReservedReleaseSol(pos, leg.qtyTokens);
  ledger.reservedSol -= release;
  pos.reservedSol = Math.max(0, (pos.reservedSol ?? 0) - release);
  pos.qtyTokens = pos.remainingQty;
  ledger.realizedPnlSol += leg.pnlSol;
}

/** Settle the final leg of a close, then sweep float dust (no cash credit). */
export function settleCloseLeg(
  cfg: EngineConfig,
  ledger: LedgerBalances,
  pos: Position,
  leg: ExitLeg,
): void {
  settlePartial(cfg, ledger, pos, leg);
  if ((pos.reservedSol ?? 0) > 0) {
    ledger.reservedSol -= pos.reservedSol!;
    pos.reservedSol = 0;
  }
  pos.qtyTokens = 0;
  pos.remainingQty = 0;
  if (ledger.reservedSol < 0) ledger.reservedSol = 0;
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
export function openReport(cfg: EngineConfig, pos: Position, cashAfter: number, reservedAfter: number, solUsd: number | null): string {
  const valUsd = pos.sizeSol * (solUsd ?? pos.solUsdAtEntry);
  return [
    `🟢 **PAPER OPEN** — $${pos.symbol} (${pos.mint.slice(0, 8)}…)`,
    ``,
    `👛 Wallet: \`${pos.walletLabel}\` (\`${pos.wallet.slice(0, 8)}…\`)`,
    `💰 Entry: ${fmtUsd(pos.entryPriceUsd)} | Size: **${pos.sizeSol} ${unitOf(cfg)}** (~${fmtUsd(valUsd)})`,
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
    `💼 Cash: ${pos.cashBeforeSol.toFixed(4)} → ${pos.cashAfterSol.toFixed(4)} | Reserved: ${pos.reservedAfterSol.toFixed(4)}`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🔔 Partial take-profit update. */
export function partialReport(cfg: EngineConfig, pos: Position, leg: ExitLeg, solUsd: number | null): string {
  const usd = solUsd ? ` (~${fmtUsd(leg.pnlSol * solUsd)})` : '';
  return [
    `🔔 **PARTIAL TP** — $${pos.symbol}`,
    ``,
    `• Sold ${(leg.qtyTokens / (pos.openQty || pos.qtyTokens) * 100).toFixed(0)}% at ${fmtUsd(leg.priceUsd)} (${fmtPct(leg.priceUsd / pos.entryPriceUsd - 1)})`,
    `• Realized: **${leg.pnlSol >= 0 ? '+' : ''}${leg.pnlSol.toFixed(5)} ${unitOf(cfg)}**${usd}`,
    `• Runner left: ${(pos.remainingQty).toFixed(2)} tokens | stop now ${fmtUsd(pos.stopPriceUsd)}`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🔴 Close-position alert body with full stats. */
export function closeReport(
  cfg: EngineConfig,
  pos: Position,
  cashAfter: number,
  solUsd: number | null,
  stats: { closed: number; wins: number; totalPnlSol: number },
): string {
  const pnl = pos.pnlSol - pos.feeOpenSol;
  const icon = pnl >= 0 ? '🟢' : '🔴';
  const U = cfg.unitLabel ?? 'SOL';
  const winrate = stats.closed > 0 ? `${((stats.wins / stats.closed) * 100).toFixed(1)}% (${stats.wins}/${stats.closed})` : 'n/a';
  const usd = solUsd ? ` (~${fmtUsd(pnl * solUsd)})` : '';
  return [
    `${icon} **PAPER CLOSE** — $${pos.symbol} — ${pos.closeReason}`,
    ``,
    `👛 Wallet: \`${pos.walletLabel}\``,
    `💰 Entry: ${fmtUsd(pos.entryPriceUsd)} | Exit: ${fmtUsd(pos.legs.at(-1)?.priceUsd ?? NaN)}`,
    `⏱️ Duration: ${durStr((pos.legs.at(-1)?.atMs ?? pos.openedAtMs) - pos.openedAtMs)}`,
    `👥 Tracked buyers (24h): **${pos.buyers24h}**`,
    ``,
    `📜 **Legs**`,
    pos.legs.map((l) => `• ${l.label}: ${fmtUsd(l.priceUsd)} (${fmtPct(l.priceUsd / pos.entryPriceUsd - 1)}) → ${l.pnlSol >= 0 ? '+' : ''}${l.pnlSol.toFixed(5)} ${U}`).join('\n'),
    ``,
    `💰 **Position PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} ${U}**${usd}`,
    `💼 Cash: ${pos.cashBeforeSol.toFixed(4)} → **${pos.cashAfterSol.toFixed(4)}** | Reserved: ${pos.reservedAfterSol.toFixed(4)}`,
    ``,
    `📊 **Session**: winrate ${winrate} | total ${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} ${U} over ${stats.closed} closed`,
    `🆔 \`${pos.id}\``,
  ].join('\n');
}

/** 🚀 Startup card proving the service, config and Telegram path are live. */
export function startupReport(cfg: EngineConfig, tracked: number, cashSol: number, reservedSol: number, unrealizedPnlSol: number): string {
  const equity = cashSol + reservedSol + unrealizedPnlSol;
  return [
    `🚀 **Paper-copy reporter live**`,
    ``,
    `👀 Tracking **${tracked}** leader wallets (5-min sweep)`,
    `💰 Size **${cfg.posSizeSol} ${cfg.unitLabel ?? 'SOL'}**/pos | TP ${cfg.tpLadder.map((r) => `+${(r.pct * 100).toFixed(0)}%×${(r.share * 100).toFixed(0)}%`).join(' ')} | Trail ${(cfg.trailPct * 100).toFixed(0)}% | Hold ${cfg.maxHoldSec <= 0 ? 'off' : `≤${(cfg.maxHoldSec / 3600).toFixed(1)}h`}`,
    `💼 Cash: **${cashSol.toFixed(4)}** | Reserved: **${reservedSol.toFixed(4)}** | Unrealized: **${unrealizedPnlSol.toFixed(4)}** | Equity: **${(cashSol + reservedSol + unrealizedPnlSol).toFixed(4)}**`,
    `📝 Reports: open / partial-TP / close with PnL, winrate, equity`,
  ].join('\n');
}
