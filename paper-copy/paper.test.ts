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

  test("ledger audit catches drift and passes clean books", async () => {
    const { auditLedger } = await import("./engine");
    const pos = {
      qtyTokens: 100, entryPriceUsd: 1, sizeSol: 0.05, feeOpenSol: 0.0002, feeLegSol: 0.0001,
      legs: [{ qtyTokens: 50, priceUsd: 1.2, pnlSol: 0.0099 }],
    };
    // balance = 10 - 0.0502 + (0.5*0.05*1.2 - 0.0001) = 10 - 0.0502 + 0.0299
    expect(auditLedger({ startBalance: 10, balance: 9.9797, positions: [pos], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001 })).toBeNull();
    expect(auditLedger({ startBalance: 10, balance: 9.5, positions: [pos], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001 })).not.toBeNull();
    expect(auditLedger({ startBalance: 10, balance: NaN, positions: [], posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001 })).not.toBeNull();
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
  test("passes clean books, anchors legacy gap once, trips on new drift", async () => {
    const { auditLedger, ledgerExpected } = await import("./engine");
    const base = { startBalance: 10, posSize: 0.05, feeOpen: 0.0002, feeLeg: 0.0001 };
    const pos = {
      qtyTokens: 100, entryPriceUsd: 1, sizeSol: 0.05, feeOpenSol: 0.0002, feeLegSol: 0.0001,
      legs: [{ qtyTokens: 50, priceUsd: 1.2, pnlSol: 0.0099 }],
    };
    const clean = 10 - 0.0502 + (0.5 * 0.05 * 1.2 - 0.0001);
    expect(auditLedger({ ...base, balance: clean, positions: [pos] })).toBeNull();
    expect(ledgerExpected({ ...base, positions: [pos] })).toBeCloseTo(clean, 9);
    // Legacy books carry unrecorded credits: plain audit trips...
    expect(auditLedger({ ...base, balance: clean + 1.5, positions: [pos] })).not.toBeNull();
    // ...but the same books pass with the anchor, and new drift still trips.
    expect(auditLedger({ ...base, balance: clean + 1.5, positions: [pos], legacyOffset: 1.5 })).toBeNull();
    expect(auditLedger({ ...base, balance: clean + 1.6, positions: [pos], legacyOffset: 1.5 })).not.toBeNull();
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
    const o = openReport(cfg, p, 9.95, 100);
    const stats0 = { closed: 3, wins: 2, totalPnlSol: 0.05 };
    const c = closeReport(cfg, { ...p, status: 'closed' as const, closeReason: 'TP +40% (ladder complete)', legs: [...p.legs, { kind: 'tp' as const, label: 'TP +40% (ladder complete)', priceUsd: 3.0, qtyTokens: p.remainingQty, pnlSol: 0.02, atMs: 2000 }] }, 10.0, 100, stats0);
    const s = startupReport(cfg, 12, 10);
    for (const t of [o, c, s]) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(50);
    }
    expect(o).toContain("0.05 SOL");
    expect(c).toContain("winrate");
  });
});
