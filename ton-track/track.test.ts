import { describe, expect, test } from "bun:test";
import { estimatePriceHoursAgo, TON_CONFIG } from "./track";
import { openPosition, tickPosition } from "../paper-copy/engine";

describe("4h-ago estimate", () => {
  test("RizzGram live numbers land near $0.0536", () => {
    const est = estimatePriceHoursAgo(0.05871, 4, { h1: null, h6: 14.67, h24: 4206 });
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(0.05);
    expect(est!).toBeLessThan(0.05871);
    expect(est!).toBeCloseTo(0.0536, 3);
  });

  test("garbage in, null out", () => {
    expect(estimatePriceHoursAgo(0, 4, { h1: null, h6: 14, h24: 4000 })).toBeNull();
    expect(estimatePriceHoursAgo(1, 0, { h1: 5, h6: null, h24: null })).toBeNull();
    expect(estimatePriceHoursAgo(1, 4, { h1: null, h6: null, h24: null })).toBeNull();
  });

  test("inside shortest window pro-rates hourly", () => {
    // +10% over 1h => 30min ago ≈ 1.1^0.5 discount.
    const est = estimatePriceHoursAgo(1.1, 0.5, { h1: 10, h6: null, h24: null });
    expect(est!).toBeCloseTo(1.1 / Math.sqrt(1.1), 6);
  });
});

describe("TON scenario lifecycle (USD units, no timeout)", () => {
  test("TP1 partial then TP2 close in USD", () => {
    const pos = openPosition(TON_CONFIG, {
      id: "s", mint: "M", symbol: "T", wallet: "tracker", walletLabel: "entry-now",
      entryPriceUsd: 0.05, solUsdAtEntry: 1, atMs: 0, balanceBeforeSol: 1000,
      buyers24h: 5, liqUsd: 18000, mcapUsd: 60000, ageHours: 16, rugScore: null,
    });
    expect(pos.qtyTokens).toBeCloseTo(25 / 0.05, 6);
    let ev = tickPosition(TON_CONFIG, pos, 0.05 * 1.13, 1000);
    expect(ev.partials).toHaveLength(1);
    expect(ev.closed).toBe(false);
    ev = tickPosition(TON_CONFIG, pos, 0.05 * 1.45, 2000);
    expect(ev.closed).toBe(true);
  });

  test("no max-hold timeout when disabled", () => {
    const pos = openPosition(TON_CONFIG, {
      id: "s", mint: "M", symbol: "T", wallet: "tracker", walletLabel: "x",
      entryPriceUsd: 0.05, solUsdAtEntry: 1, atMs: 0, balanceBeforeSol: 1000,
      buyers24h: 0, liqUsd: null, mcapUsd: null, ageHours: null, rugScore: null,
    });
    const ev = tickPosition(TON_CONFIG, pos, 0.051, 10 * 3600_000);
    expect(ev.closed).toBe(false);
    expect(pos.status).toBe("open");
  });
});
