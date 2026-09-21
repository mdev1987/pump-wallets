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
