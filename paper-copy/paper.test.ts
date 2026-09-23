import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  assessRug,
  openPosition,
  tickPosition,
  positionPnlSol,
  openReport,
  closeReport,
  startupReport,
  type Position,
} from "./engine";

describe("rug gate (normalized scale, danger-based veto)", () => {
  test("vetoes danger findings, warns through mid scores", () => {
    expect(assessRug(null).veto).toBe(false);
    expect(assessRug({ score_normalised: 61, risks: [{ name: "Low Liquidity", level: "warn" }] }).veto).toBe(false);
    const danger = assessRug({ score_normalised: 61, risks: [{ name: "Mint authority", level: "danger" }] });
    expect(danger.veto).toBe(true);
    expect(danger.reason).toContain("Mint authority");
    expect(assessRug({ score_normalised: 95, risks: [] }).veto).toBe(true);
  });

  test("does not mistake the raw additive score for risk", () => {
    // Real summary shape: raw score in the thousands next to a 0-100 normalized one.
    const r = assessRug({ score: 10146, score_normalised: 50, risks: [] });
    expect(r.veto).toBe(false);
    expect(r.score).toBe(50);
  });
});

const cfg = { ...DEFAULT_CONFIG };

function mkPos(entry = 1.0): Position {
  return openPosition(cfg, {
    id: "t1", mint: "MINT", symbol: "TST", wallet: "W", walletLabel: "W",
    entryPriceUsd: entry, solUsdAtEntry: 100, atMs: 0, balanceBeforeSol: 10,
    buyers24h: 2, liqUsd: 20000, mcapUsd: 100000, ageHours: 5, rugScore: 10,
  });
}

describe("entry gates", () => {
  test("momentum veto blocks vertical m5 prints, passes the rest", async () => {
    const { momentumBlocked } = await import("./engine");
    expect(momentumBlocked(35)).toBe(true);
    expect(momentumBlocked(20)).toBe(false);
    expect(momentumBlocked(-50)).toBe(false);
    expect(momentumBlocked(null)).toBe(false);
    expect(momentumBlocked(NaN)).toBe(false);
  });

  test("wallet daily budget caps one actor at N opens/day", async () => {
    const { walletDayAllowed, walletDayRecord } = await import("./engine");
    const b = {};
    const day = Date.parse("2026-09-21T12:00:00Z");
    expect(walletDayAllowed(b, "W", day, 3)).toBe(true);
    walletDayRecord(b, "W", day);
    walletDayRecord(b, "W", day);
    walletDayRecord(b, "W", day);
    expect(walletDayAllowed(b, "W", day, 3)).toBe(false);
    expect(walletDayAllowed(b, "X", day, 3)).toBe(true);
    // Next UTC day resets.
    expect(walletDayAllowed(b, "W", day + 86400_000, 3)).toBe(true);
  });

  test("ledger audit uses cash+reserved vs start+realized equity", async () => {
    const { auditLedger, ledgerExpected } = await import("./engine");
    const pos = {
      qtyTokens: 100, entryPriceUsd: 1, sizeSol: 0.05, feeOpenSol: 0.0002, feeLegSol: 0.0001,
      legs: [{ qtyTokens: 50, priceUsd: 1.2, pnlSol: 0.0099 }],
    };
    // equity: cash 9.9 + reserved 0.1 = 10.0 = start + realized 0
    expect(auditLedger({
      startBalance: 10, balance: 9.9, reserved: 0.1, realized: 0,
      positions: [pos], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001,
    })).toBeNull();
    // realized +0.05 but equity still 10.0 -> drift
    expect(auditLedger({
      startBalance: 10, balance: 9.9, reserved: 0.1, realized: 0.05,
      positions: [pos], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001,
    })).not.toBeNull();
    expect(auditLedger({
      startBalance: 10, balance: NaN, reserved: 0, realized: 0,
      positions: [], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001,
    })).not.toBeNull();
    expect(ledgerExpected({
      startBalance: 10, positions: [pos], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001,
      realized: 0.05, reserved: 0.1,
    })).toBeCloseTo(9.95, 9);
  });
});

describe("two-tier sweep delta", () => {
  test("boot marks position, overlap counts fresh, miss takes window", async () => {
    const { sigsDelta } = await import("./engine");
    expect(sigsDelta([], null)).toEqual({ fresh: 0, newest: null });
    expect(sigsDelta(['c', 'b', 'a'], null)).toEqual({ fresh: 0, newest: 'c' });
    expect(sigsDelta(['c', 'b', 'a'], 'c')).toEqual({ fresh: 0, newest: 'c' });
    expect(sigsDelta(['d', 'c', 'b'], 'b')).toEqual({ fresh: 2, newest: 'd' });
    expect(sigsDelta(['z', 'y'], 'gone')).toEqual({ fresh: 2, newest: 'z' });
  });
});

describe("ledger audit", () => {
  test("passes clean equity books, anchors legacy gap once, trips on new drift", async () => {
    const { auditLedger, ledgerExpected } = await import("./engine");
    const base = { startBalance: 10, posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001 };
    const pos = {
      qtyTokens: 100, entryPriceUsd: 1, sizeSol: 0.05, feeOpenSol: 0.0002, feeLegSol: 0.0001,
      legs: [{ qtyTokens: 50, priceUsd: 1.2, pnlSol: 0.0099 }],
    };
    // cash 9.9 + reserved 0.1 = 10 = start + realized 0
    expect(auditLedger({ ...base, balance: 9.9, reserved: 0.1, realized: 0, positions: [pos] })).toBeNull();
    expect(ledgerExpected({ ...base, positions: [pos], realized: 0, reserved: 0.1 })).toBeCloseTo(9.9, 9);
    // Legacy equity gap of +1.5: plain audit trips...
    expect(auditLedger({ ...base, balance: 11.4, reserved: 0.1, realized: 0, positions: [pos] })).not.toBeNull();
    // ...passes with the anchor; new drift past anchor still trips.
    expect(auditLedger({ ...base, balance: 11.4, reserved: 0.1, realized: 0, positions: [pos], legacyOffset: 1.5 })).toBeNull();
    expect(auditLedger({ ...base, balance: 11.5, reserved: 0.1, realized: 0, positions: [pos], legacyOffset: 1.5 })).not.toBeNull();
  });
});

describe("paper engine lifecycle", () => {
  test("ladder fills rung by rung, closes when exhausted", () => {
    const p = mkPos(1.0);
    let ev = tickPosition(cfg, p, 1.1, 1000);
    expect(ev.partials).toHaveLength(0);
    expect(ev.closed).toBe(false);
    ev = tickPosition(cfg, p, 1.26, 2000); // rung 1 (+12%) fills half
    expect(ev.partials).toHaveLength(1);
    expect(ev.partials[0]!.kind).toBe("tp");
    expect(ev.partials[0]!.label).toContain("+12%");
    expect(ev.closed).toBe(false);
    expect(p.remainingQty).toBeCloseTo(p.qtyTokens * 0.5, 9);
    ev = tickPosition(cfg, p, 1.5, 3000); // rung 2 (+40%) empties -> complete
    expect(ev.closed).toBe(true);
    expect(p.closeReason).toContain("ladder complete");
    expect(positionPnlSol(p)).toBeGreaterThan(0);
  });

  test("partial fills persist in pos.legs exactly once (ledger integrity)", () => {
    const p = mkPos(1.0);
    const credited: number[] = [];
    let ev = tickPosition(cfg, p, 1.26, 2000);
    for (const l of ev.partials) credited.push(l.qtyTokens);
    // Emulate the service: partials credited now, close leg credited at close.
    ev = tickPosition(cfg, p, 1.5, 3000);
    for (const l of ev.partials) credited.push(l.qtyTokens);
    if (ev.closed) {
      const last = p.legs.at(-1)!;
      credited.push(last.qtyTokens);
    }
    // Every credited token accounted once across legs; legs match positions.
    const legsTotal = p.legs.reduce((s, l) => s + l.qtyTokens, 0);
    expect(legsTotal).toBeCloseTo(p.qtyTokens, 9);
    expect(credited.reduce((s, q) => s + q, 0)).toBeCloseTo(p.qtyTokens, 9);
    expect(positionPnlSol(p)).toBeGreaterThan(0);
  });

  test("partial ladder leaves a runner for trail/timeout", () => {
    const twoRung = { ...cfg, tpLadder: [{ pct: 1.0, share: 0.2 }, { pct: 2.0, share: 0.2 }] };
    const p = mkPos(1.0);
    let ev = tickPosition(twoRung, p, 2.1, 1000); // +110%: rung 1 only
    expect(ev.partials).toHaveLength(1);
    expect(ev.closed).toBe(false);
    expect(p.remainingQty).toBeCloseTo(p.qtyTokens * 0.8, 9);
    ev = tickPosition(twoRung, p, 3.1, 2000); // +210%: rung 2, 60% rides
    expect(ev.partials).toHaveLength(1);
    expect(ev.closed).toBe(false);
    expect(p.remainingQty).toBeCloseTo(p.qtyTokens * 0.6, 9);
    expect(p.status).toBe("open");
  });

  test("trailing stop ratchets with peak and exits", () => {
    const p = mkPos(1.0);
    tickPosition(cfg, p, 1.1, 1000); // peak 1.1 -> stop 0.935 (below TP1)
    expect(p.stopPriceUsd).toBeCloseTo(1.1 * (1 - cfg.trailPct), 6);
    const ev = tickPosition(cfg, p, 0.93, 2000); // below stop
    expect(ev.closed).toBe(true);
    expect(p.closeReason).toContain("trailing");
  });

  test("stop never ratchets down on dips", () => {
    const p = mkPos(1.0);
    tickPosition(cfg, p, 1.1, 1000);
    tickPosition(cfg, p, 1.0, 2000);
    expect(p.stopPriceUsd).toBeCloseTo(1.1 * (1 - cfg.trailPct), 6);
    expect(p.status).toBe("open");
  });

  test("stop tightens after TP1 fill", () => {
    const p = mkPos(1.0);
    tickPosition(cfg, p, 1.1, 1000);
    expect(p.stopPriceUsd).toBeCloseTo(1.1 * (1 - cfg.trailPct), 6);
    const ev = tickPosition(cfg, p, 1.13, 2000); // TP1 fills at +13%
    expect(ev.partials).toHaveLength(1);
    expect(p.stopPriceUsd).toBeCloseTo(1.13 * (1 - cfg.trailTightPct), 6);
    // Fade to between wide and tight stop: survives wide, dies on tight.
    const ev2 = tickPosition(cfg, p, 1.0, 3000);
    expect(ev2.closed).toBe(true);
    expect(p.closeReason).toContain("trailing");
  });

  test("max-hold timeout exits flat-ish positions", () => {
    const p = mkPos(1.0);
    const ev = tickPosition(cfg, p, 1.05, cfg.maxHoldSec * 1000 + 1);
    expect(ev.closed).toBe(true);
    expect(p.closeReason).toContain("max hold");
  });

  test("reports render without throwing and carry key fields", () => {
    const p = mkPos(2.0);
    tickPosition(cfg, p, 2.6, 1000);
    const stats = { closed: 3, wins: 2, totalPnlSol: 0.05 };
    const o = openReport(cfg, p, 9.95, 0.05, 100);
    const stats0 = { closed: 3, wins: 2, totalPnlSol: 0.05 };
    const c = closeReport(cfg, { ...p, status: 'closed' as const, closeReason: 'TP +40% (ladder complete)', legs: [...p.legs, { kind: 'tp' as const, label: 'TP +40% (ladder complete)', priceUsd: 3.0, qtyTokens: p.remainingQty, pnlSol: 0.02, atMs: 2000 }] }, 10.0, 100, stats0);
    const s = startupReport(cfg, 12, 10, 0, 0);
    for (const t of [o, c, s]) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(50);
    }
    expect(o).toContain("0.05 SOL");
    expect(c).toContain("winrate");
  });
});

describe("position cost basis + report", () => {
  test("openQty/reserved track size; reserved release is cost share only", async () => {
    const { legReservedReleaseSol, legProceedsSol } = await import("./engine");
    const p = mkPos(1.0);
    expect(p.openQty).toBeCloseTo(p.qtyTokens, 9);
    expect(p.reservedSol).toBeCloseTo(cfg.posSizeSol, 9);
    const half = p.openQty * 0.5;
    expect(legReservedReleaseSol(p, half)).toBeCloseTo(cfg.posSizeSol * 0.5, 9);
    expect(legProceedsSol(p, half, 2.0)).toBeCloseTo(cfg.posSizeSol * 0.5 * 2, 9);
    // After selling half, remaining reserved = size - half release
    p.reservedSol -= legReservedReleaseSol(p, half);
    expect(p.reservedSol).toBeCloseTo(cfg.posSizeSol * 0.5, 9);
    // Rest of size releases fully (no feeOpen in reserved)
    expect(legReservedReleaseSol(p, half)).toBeCloseTo(cfg.posSizeSol * 0.5, 9);
  });

  test("TP ladder shares are fractions of openQty after qtyTokens shrinks", () => {
    const twoRung = { ...cfg, tpLadder: [{ pct: 0.5, share: 0.5 }, { pct: 1.0, share: 0.5 }] };
    const p = mkPos(1.0);
    // Simulate service reducing qtyTokens after first partial
    let ev = tickPosition(twoRung, p, 1.6, 1000); // +60% first rung
    expect(ev.partials).toHaveLength(1);
    expect(ev.partials[0]!.qtyTokens).toBeCloseTo(p.openQty * 0.5, 9);
    p.qtyTokens = p.remainingQty; // service path
    ev = tickPosition(twoRung, p, 2.1, 2000); // second rung takes openQty*0.5
    expect(ev.closed).toBe(true);
    expect(p.closeReason).toContain("ladder complete");
    // Ladder-complete restores remainingQty to the last fill so the service
    // credits it once; legs still sum to the original openQty.
    const legsQty = p.legs.reduce((s, l) => s + l.qtyTokens, 0);
    expect(legsQty).toBeCloseTo(p.openQty, 9);
  });

  test("report joins closed to wallets, computes expectancy and flags toxic", async () => {
    const { buildReport, buildTrades } = await import("./report");
    const positions = [
      { id: "a", wallet: "W1", walletLabel: "W1", symbol: "AAA", mint: "M1", status: "closed" as const, openedAtMs: 1000, pnlSol: 0.01, feeOpenSol: 0.0002, closeReason: "trailing", legs: [] },
      { id: "b", wallet: "W2", walletLabel: "W2", symbol: "BBB", mint: "M2", status: "closed" as const, openedAtMs: 2000, pnlSol: -0.02, feeOpenSol: 0.0002, closeReason: "trailing", legs: [] },
      { id: "c", wallet: "W2", walletLabel: "W2", symbol: "CCC", mint: "M3", status: "closed" as const, openedAtMs: 3000, pnlSol: -0.02, feeOpenSol: 0.0002, closeReason: "timeout", legs: [] },
    ];
    const closed = [
      { id: "a", mint: "M1", symbol: "AAA", wallet: "W1", pnlSol: 0.0098, win: true, atMs: 5000, holdMs: 4000, closeReason: "trailing" },
      { id: "b", mint: "M2", symbol: "BBB", wallet: "W2", pnlSol: -0.0202, win: false, atMs: 6000, holdMs: 4000, closeReason: "trailing" },
      { id: "c", mint: "M3", symbol: "CCC", wallet: "W2", pnlSol: -0.0202, win: false, atMs: 7000, holdMs: 4000, closeReason: "timeout" },
    ];
    const state = {
      cashSol: 10, reservedSol: 0, realizedPnlSol: -0.03, unrealizedPnlSol: 0,
      positions, closed,
    };
    const trades = buildTrades(state);
    expect(trades).toHaveLength(3);
    expect(trades.every((t) => t.wallet === "W1" || t.wallet === "W2")).toBe(true);
    const r = buildReport(state);
    expect(r.totalTrades).toBe(3);
    const w1 = r.wallets.find((w) => w.wallet === "W1")!;
    const w2 = r.wallets.find((w) => w.wallet === "W2")!;
    expect(w1.winRate).toBe(1);
    expect(w2.trades).toBe(2);
    expect(w2.winRate).toBe(0);
    expect(r.totalPnlSol).toBeCloseTo(0.0098 - 0.0202 - 0.0202, 6);
    expect(w1.trades + w2.trades).toBe(3);
    // Toxic needs n>=5; W2 has 2 — not toxic yet
    expect(w2.toxic).toBe(false);
    // Lead latency present when leaderBuyTs set
    const withLead = buildTrades({
      ...state,
      closed: [{ ...closed[0]!, leaderBuyTs: 900 }],
      positions: [positions[0]!],
    });
    expect(withLead[0]!.leadMs).toBe(100); // open 1000 - leader 900
  });
});

describe("review fixes: settle, filters, recompute", () => {
  test("settlePartial + settleCloseLeg keep cash+reserved == start+realized", async () => {
    const { settlePartial, settleCloseLeg } = await import("./engine");
    const p = mkPos(1.0);
    const ledger = { cashSol: 10 - cfg.posSizeSol - cfg.feeOpenSol, reservedSol: cfg.posSizeSol, realizedPnlSol: -cfg.feeOpenSol };
    // First rung fills at +26%
    let ev = tickPosition(cfg, p, 1.26, 1000);
    expect(ev.partials).toHaveLength(1);
    for (const leg of ev.partials) settlePartial(cfg, ledger, p, leg);
    expect(ledger.cashSol + ledger.reservedSol).toBeCloseTo(10 + ledger.realizedPnlSol, 9);
    expect(p.qtyTokens).toBeCloseTo(p.remainingQty, 9);
    // Second rung closes the rest
    ev = tickPosition(cfg, p, 1.5, 2000);
    expect(ev.closed).toBe(true);
    const last = p.legs.at(-1)!;
    expect(ev.partials.includes(last)).toBe(false);
    settleCloseLeg(cfg, ledger, p, last);
    expect(ledger.cashSol + ledger.reservedSol).toBeCloseTo(10 + ledger.realizedPnlSol, 9);
    expect(ledger.reservedSol).toBe(0);
    expect(p.qtyTokens).toBe(0);
    expect(p.remainingQty).toBe(0);
  });

  test("trail close after a partial credits remaining cost only", async () => {
    const { settlePartial, settleCloseLeg } = await import("./engine");
    const twoRung = { ...cfg, tpLadder: [{ pct: 0.2, share: 0.5 }, { pct: 5.0, share: 0.5 }] };
    const p = mkPos(1.0);
    const ledger = { cashSol: 10 - cfg.posSizeSol - cfg.feeOpenSol, reservedSol: cfg.posSizeSol, realizedPnlSol: -cfg.feeOpenSol };
    let ev = tickPosition(twoRung, p, 1.25, 1000);
    expect(ev.partials).toHaveLength(1);
    for (const leg of ev.partials) settlePartial(cfg, ledger, p, leg);
    const cashAfterPartial = ledger.cashSol;
    ev = tickPosition(twoRung, p, 1.0, 2000); // fades under tight stop
    expect(ev.closed).toBe(true);
    const last = p.legs.at(-1)!;
    settleCloseLeg(cfg, ledger, p, last);
    // Remaining was half the size: proceeds ≈ half size at entry (flat exit)
    expect(ledger.cashSol - cashAfterPartial).toBeCloseTo(cfg.posSizeSol * 0.5 * (1.0 / 1.0) - cfg.feeLegSol, 9);
    expect(ledger.cashSol + ledger.reservedSol).toBeCloseTo(10 + ledger.realizedPnlSol, 9);
  });

  test("asMs normalizes Helius seconds, passes through ms", async () => {
    const { asMs } = await import("./engine");
    expect(asMs(1758000000)).toBe(1758000000000);
    expect(asMs(1758000000000)).toBe(1758000000000);
  });

  test("mcapBlocked: unknown passes, over-cap blocks", async () => {
    const { mcapBlocked } = await import("./engine");
    expect(mcapBlocked(null, 3_000_000)).toBe(false);
    expect(mcapBlocked(1_000_000, 3_000_000)).toBe(false);
    expect(mcapBlocked(5_000_000, 3_000_000)).toBe(true);
    expect(mcapBlocked(NaN, 3_000_000)).toBe(false);
  });

  test("walletToxic flags n>=5 negative expectancy only", async () => {
    const { walletToxic, walletTradeStats } = await import("./engine");
    const closed = [
      ...Array.from({ length: 6 }, (_, i) => ({ wallet: "BAD", pnlSol: -0.01 })),
      ...Array.from({ length: 6 }, (_, i) => ({ wallet: "GOOD", pnlSol: 0.01 })),
      ...Array.from({ length: 2 }, (_, i) => ({ wallet: "NEW", pnlSol: -0.05 })),
    ];
    expect(walletToxic(closed, "BAD")).toBe(true);
    expect(walletToxic(closed, "GOOD")).toBe(false);
    expect(walletToxic(closed, "NEW")).toBe(false); // n<5
    expect(walletToxic(closed, "MISSING")).toBe(false);
    expect(walletTradeStats(closed, "BAD").expectancySol).toBeCloseTo(-0.01, 9);
  });

  test("expectedCashFromLegs matches a settled ledger exactly", async () => {
    const { expectedCashFromLegs, settlePartial, settleCloseLeg } = await import("./engine");
    const p = mkPos(2.0);
    const ledger = { cashSol: 10 - cfg.posSizeSol - cfg.feeOpenSol, reservedSol: cfg.posSizeSol, realizedPnlSol: -cfg.feeOpenSol };
    let ev = tickPosition(cfg, p, 2.6, 1000);
    for (const leg of ev.partials) settlePartial(cfg, ledger, p, leg);
    ev = tickPosition(cfg, p, 3.0, 2000);
    if (ev.closed) {
      const last = p.legs.at(-1)!;
      if (!ev.partials.includes(last)) settleCloseLeg(cfg, ledger, p, last);
    }
    const recomputed = expectedCashFromLegs({
      startBalance: 10, positions: [p], posSize: cfg.posSizeSol, feeOpen: cfg.feeOpenSol, feeLeg: cfg.feeLegSol,
    });
    expect(recomputed).toBeCloseTo(ledger.cashSol, 9);
  });

  test("expectedCashFromLegs returns NaN on corrupt legs", async () => {
    const { expectedCashFromLegs } = await import("./engine");
    const bad = {
      qtyTokens: 100, entryPriceUsd: 1, sizeSol: 0.05, feeOpenSol: 0.0002, feeLegSol: 0.0001,
      legs: [{ qtyTokens: 50, priceUsd: NaN, pnlSol: 0 }],
    };
    expect(expectedCashFromLegs({ startBalance: 10, positions: [bad], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001 })).toBeNaN();
  });

  test("cash audit trips on divergence, passes with anchor", async () => {
    const { auditLedger } = await import("./engine");
    const pos = {
      qtyTokens: 100, openQty: 100, entryPriceUsd: 1, sizeSol: 0.05, feeOpenSol: 0.0002, feeLegSol: 0.0001,
      legs: [{ qtyTokens: 100, priceUsd: 1.0, pnlSol: -0.0001 }],
    };
    const base = { startBalance: 10, balance: 0, positions: [pos], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001, reserved: 0, realized: -0.0003 };
    // recomputed cash = 10 - 0.0502 + (0.05*1 - 0.0001) = 9.9997
    expect(auditLedger({ ...base, balance: 9.9997, cash: 9.9997 })).toBeNull();
    // Equity holds (balance 9.9997) but legs-cash diverges -> cash drift
    const drifted = auditLedger({ ...base, balance: 9.9997, cash: 9.5 });
    expect(drifted).not.toBeNull();
    expect(drifted).toContain("cash drift");
    expect(auditLedger({ ...base, balance: 9.9997, cash: 9.5, cashOffset: -0.4997 })).toBeNull();
  });

  test("partialReport percent uses openQty after qty sync", async () => {
    const { partialReport } = await import("./engine");
    const p = mkPos(1.0);
    p.remainingQty = p.openQty * 0.5;
    p.qtyTokens = p.remainingQty; // post-settle sync
    const leg = { kind: "tp" as const, label: "TP", priceUsd: 1.2, qtyTokens: p.openQty * 0.5, pnlSol: 0.01, atMs: 1 };
    expect(partialReport(cfg, p, leg, null)).toContain("Sold 50%");
  });

  test("closeRest with dust-only remainder records no phantom leg", () => {
    const p = mkPos(1.0);
    // Simulate: everything sold via fills except sub-dust remainder, no partials this tick
    p.remainingQty = p.openQty * 0.0005;
    p.tpDone = [true];
    const legsBefore = p.legs.length;
    const ev = tickPosition({ ...cfg, tpLadder: [] }, p, 0.5, cfg.maxHoldSec * 1000 + 1);
    expect(ev.closed).toBe(true);
    // timeout path with tiny qty still records (qty>0); assert no zero-qty legs ever
    expect(p.legs.every((l) => l.qtyTokens > 0)).toBe(true);
    expect(p.legs.length).toBe(legsBefore + 1);
  });

  test("report guards absurd leadMs and nulls empty profit factor", async () => {
    const { buildReport, buildTrades } = await import("./report");
    const state = {
      cashSol: 10, reservedSol: 0, realizedPnlSol: 0, unrealizedPnlSol: 0,
      positions: [
        { id: "a", wallet: "W1", walletLabel: "W1", symbol: "A", mint: "M", status: "closed" as const, openedAtMs: 1_758_000_000_000, pnlSol: 0.01, feeOpenSol: 0.0002, closeReason: "trail", legs: [] },
      ],
      closed: [
        // seconds-unit leader ts (legacy bug): lead would be ~55y -> nulled
        { id: "a", mint: "M", symbol: "A", wallet: "W1", pnlSol: 0.01, win: true, atMs: 1_758_000_100_000, holdMs: 100_000, closeReason: "trail", leaderBuyTs: 1_758_000_000 },
      ],
    };
    const trades = buildTrades(state);
    expect(trades[0]!.leadMs).toBeNull();
    const r = buildReport(state);
    expect(r.wallets[0]!.profitFactor).toBeNull(); // no losses -> null, not Infinity
    expect(r.wallets[0]!.avgLeadMs).toBeNull();
  });
});

describe("improvements batch: mcap, windows, lead buckets", () => {
  test("assessMcap: unknown ok, over-cap blocks, absurd is bad data", async () => {
    const { assessMcap, mcapBlocked } = await import("./engine");
    expect(assessMcap(null, 3_000_000)).toBe("ok");
    expect(assessMcap(1_000_000, 3_000_000)).toBe("ok");
    expect(assessMcap(42_000_000, 3_000_000)).toBe("over-cap");
    expect(assessMcap(74_726_975_266, 3_000_000)).toBe("bad-data");
    expect(mcapBlocked(74_726_975_266, 3_000_000)).toBe(false);
    expect(mcapBlocked(42_000_000, 3_000_000)).toBe(true);
  });

  test("windowed stats let wallets redeem themselves", async () => {
    const { walletTradeStats, walletToxic } = await import("./engine");
    const old = Array.from({ length: 10 }, () => ({ wallet: "W", pnlSol: -0.01 }));
    const recent = Array.from({ length: 6 }, () => ({ wallet: "W", pnlSol: 0.01 }));
    const closed = [...old, ...recent];
    // All-history view: still toxic
    expect(walletToxic(closed, "W")).toBe(true);
    expect(walletTradeStats(closed, "W").n).toBe(16);
    // Last-6 window: redeemed
    const st = walletTradeStats(closed, "W", { lastN: 6 });
    expect(st.n).toBe(6);
    expect(st.expectancySol).toBeCloseTo(0.01, 9);
  });

  test("leadBuckets split PnL by entry delay", async () => {
    const { leadBuckets } = await import("./engine");
    const trades = [
      { leadMs: 60_000, pnlSol: 0.02, win: true },
      { leadMs: 100_000, pnlSol: -0.01, win: false },
      { leadMs: 200_000, pnlSol: 0.01, win: true },
      { leadMs: 300_000, pnlSol: -0.02, win: false },
      { leadMs: null, pnlSol: 99, win: true }, // ignored
    ];
    const [fast, mid, slow] = leadBuckets(trades);
    expect(fast!.n).toBe(2);
    expect(fast!.totalPnlSol).toBeCloseTo(0.01, 9);
    expect(mid!.n).toBe(1);
    expect(slow!.n).toBe(1);
    expect(slow!.totalPnlSol).toBeCloseTo(-0.02, 9);
  });

  test("report separates book PnL from ledger residue", async () => {
    const { buildReport, formatReport } = await import("./report");
    const state = {
      cashSol: 10.35, reservedSol: 0, realizedPnlSol: 0.35, unrealizedPnlSol: 0,
      positions: [],
      closed: [{ id: "a", mint: "M", symbol: "A", wallet: "W", pnlSol: -0.01, win: false, atMs: 1, holdMs: 1, closeReason: "trail" }],
    };
    const r = buildReport(state);
    expect(r.totalPnlSol).toBeCloseTo(-0.01, 9);
    expect(r.ledgerGapSol).toBeCloseTo(0.36, 9);
    expect(formatReport(r)).toContain("not trading edge");
  });
});
