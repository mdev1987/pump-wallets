import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  openPosition,
  tickPosition,
  positionPnlSol,
  openReport,
  closeReport,
  startupReport,
  type Position,
} from "./engine";

const cfg = { ...DEFAULT_CONFIG };

function mkPos(entry = 1.0): Position {
  return openPosition(cfg, {
    id: "t1", mint: "MINT", symbol: "TST", wallet: "W", walletLabel: "W",
    entryPriceUsd: entry, solUsdAtEntry: 100, atMs: 0, balanceBeforeSol: 10,
    buyers24h: 2, liqUsd: 20000, mcapUsd: 100000, ageHours: 5, rugScore: 10,
  });
}

describe("paper engine lifecycle", () => {
  test("partial TP at +25%, final TP at +50%", () => {
    const p = mkPos(1.0);
    let ev = tickPosition(cfg, p, 1.1, 1000);
    expect(ev.partials).toHaveLength(0);
    expect(ev.closed).toBe(false);
    ev = tickPosition(cfg, p, 1.26, 2000);
    expect(ev.partials).toHaveLength(1);
    expect(ev.partials[0]!.kind).toBe("tp1");
    expect(ev.closed).toBe(false);
    expect(p.remainingQty).toBeLessThan(p.qtyTokens);
    ev = tickPosition(cfg, p, 1.5, 3000);
    expect(ev.closed).toBe(true);
    expect(p.closeReason).toContain("TP2");
    expect(positionPnlSol(p)).toBeGreaterThan(0);
  });

  test("trailing stop ratchets with peak and exits", () => {
    const p = mkPos(1.0);
    tickPosition(cfg, p, 1.2, 1000); // peak 1.2 -> stop 1.02
    expect(p.stopPriceUsd).toBeCloseTo(1.02, 6);
    const ev = tickPosition(cfg, p, 1.01, 2000); // below stop
    expect(ev.closed).toBe(true);
    expect(p.closeReason).toContain("trailing");
  });

  test("stop never ratchets down on dips", () => {
    const p = mkPos(1.0);
    tickPosition(cfg, p, 1.2, 1000);
    tickPosition(cfg, p, 1.05, 2000);
    expect(p.stopPriceUsd).toBeCloseTo(1.02, 6);
    expect(p.status).toBe("open");
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
    const c = closeReport(cfg, { ...p, status: 'closed' as const, closeReason: 'TP2 +50%', legs: [...p.legs, { kind: 'tp2' as const, priceUsd: 3.0, qtyTokens: p.remainingQty, pnlSol: 0.02, atMs: 2000 }] }, 10.0, 100, stats0);
    const s = startupReport(cfg, 12, 10);
    for (const t of [o, c, s]) {
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(50);
    }
    expect(o).toContain("0.05 SOL");
    expect(c).toContain("winrate");
  });
});
