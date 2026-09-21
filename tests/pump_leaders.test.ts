import { describe, expect, test } from "bun:test";
import {
  analyzeToken,
  maxForwardReturnFromTrade,
  parseTradesFromTransactionDetailed,
  type FetchResult,
  type RawTransaction,
  type Trade,
} from "../src/analyzer";
import { shouldSkipRescan } from "../src/rescan";

const baseConfig = {
  heliusApiKey: "x", heliusRpcBaseUrl: "x", heliusPageLimit: 100, maxHistoryPages: 100,
  heliusLightPageLimit: 1000, maxLightHistoryPages: 100, maxLightSignatures: 10000, activityBucketSec: 60,
  activeWindowSec: 300, activeWindowCount: 1, minActiveWindowTransactions: 1, activeWindowContextSec: 0,
  activeWindowMergeGapSec: 0, fullWindowMergeGapSec: 0, quietWindowSec: 60, quietWindowCount: 0,
  minQuietWindowTransactions: 0, quietSearchStartSec: 60, quietSearchEndSec: 120, quietWindowContextSec: 0,
  fineActivityBucketSec: 30, maxFullTransactionsPerWindow: 1000, maxFullQueryWindows: 10, heliusCacheEnabled: false,
  heliusCacheDir: "./data/cache", heliusLightCacheTtlSec: 0, heliusFullCacheTtlSec: 0, heliusMinIntervalMs: 0, retryAttempts: 1, retryBackoffMs: 1,
  minMarketTradeSol: 0.001, minLeaderTradeSol: 0.01, bucketSec: 1, minTokenBaseUnits: 1000, maxPumpPeakReturn: 1000, coverageMaxGapSec: 5, pumpLookbackSec: 5, pumpAccelReturn: 0.09,
  pumpConfirmSec: 5, pumpConfirmReturn: 0.02, pumpMinBuySol: 0.01, pumpBaselineSec: 30, pumpMinVolumePace: 1, pumpMinBuyPressure: 0.5,
  pumpSustainedLookbackSec: 30, pumpSustainedReturn: 0.12, pumpSustainedConfirmSec: 10, pumpSustainedConfirmReturn: 0.02,
  pumpSustainedMinBuySol: 0.01, pumpSustainedMinVolumePace: 1, pumpSustainedMinBuyPressure: 0.5,
  pumpClusterSec: 120, pumpWindowSec: 60,
  prePumpSec: 120, earlyPumpSec: 60, topWallets: 50, leadFlowWindowSec: 30, leaderResponseScale: 0.1, leaderTimingDecaySec: 30, forwardMaxExtraGapSec: 2,
  forward1Sec: 1, forward3Sec: 3, forward5Sec: 5, forward10Sec: 10, forward15Sec: 15, forward30Sec: 30, forward60Sec: 60,
  pumpPositiveRateThreshold: 0.5, reliabilityPriorPumps: 2, controlLookbackSec: 60, controlGapSec: 5, minControlTradeSol: 0.01,
  minControlBuysPerPump: 1, maxControlBuysPerPump: 10, duckdbPath: "./data/test.duckdb", duckdbThreads: 1,
  tokenOutputRoot: "./data/pump_wallet_tnxs", globalExportDir: "./data/global", logDir: "./logs", debotEnabled: false, debotScanCandidates: false,
  debot: {
    baseUrl: "https://example.com", chain: "solana", rankLimit: 10, requestTimeoutMs: 1000, apiKey: undefined, pollIntervalMs: 1000, candidateLimit: 10,
    minPumpPrecursorScore: 0, minPumpPrecursorEvidence: 1, minPumpPrecursorPositiveEvidence: 0, minActivityScore: 0, minActivityEvidence: 1, minVolumeAcceleration: 1,
    require1m: false, include1mOnly: false, accelerationSaturation: 5, activityScoreSaturation: 5, buyPressureDeltaSaturation: 0.2, requireHeatmap: false,
    maxHeatmapRecencySec: 3600, retryAttempts: 0, retryBackoffMs: 1,
    scoreWeights: { activityRank1m: 1, activityRank5m: 1, activityIntensity: 1, buyPressure1m: 1, buyPressureDelta: 1, volumeAcceleration: 1, walletAcceleration: 1 },
  },
} as any;

function rawTx(overrides: Partial<RawTransaction> & { wallet: string; solDelta: number; tokenDelta: string }): RawTransaction {
  const pre = 10_000_000_000;
  return {
    blockTime: 1_789_682_300,
    slot: 1,
    transaction: {
      signatures: [`sig-${Math.random().toString(36).slice(2)}`],
      message: { accountKeys: [{ pubkey: overrides.wallet, signer: true }] },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [pre],
      postBalances: [pre + overrides.solDelta],
      preTokenBalances: [],
      postTokenBalances: [{
        accountIndex: 0,
        mint: "TOKEN",
        owner: overrides.wallet,
        uiTokenAmount: { amount: overrides.tokenDelta, decimals: 6 },
      }],
    },
  };
}

describe("transaction parser", () => {
  test("accepts a plain SOL-for-tokens buy", () => {
    const parsed = parseTradesFromTransactionDetailed(
      rawTx({ wallet: "buyer", solDelta: -500_000_000, tokenDelta: "1000000" }),
      "TOKEN",
    );
    expect(parsed.trades).toHaveLength(1);
    expect(parsed.trades[0]!.type).toBe("buy");
    expect(parsed.reason).toBe("accepted_transactions");
  });

  test("rejects a non-signing token owner instead of inventing a wallet trade", () => {
    // Two keys: someone else is the fee payer/first key, so "owner" is
    // neither a signer nor the fee payer and must not be credited.
    const tx = rawTx({ wallet: "owner", solDelta: -500_000_000, tokenDelta: "1000000" });
    tx.transaction.message.accountKeys = [
      { pubkey: "fee-payer", signer: true },
      { pubkey: "owner", signer: false },
    ];
    tx.meta.preBalances = [10_000_000_000, 10_000_000_000];
    tx.meta.postBalances = [9_999_995_000, 9_500_000_000];
    const parsed = parseTradesFromTransactionDetailed(tx, "TOKEN");
    expect(parsed.trades).toHaveLength(0);
    expect(parsed.reason).toBe("wallet_not_signer");
  });

  test("counts substantial same-sign flows as router-like, dust as mismatch", () => {
    // Gained tokens AND gained 0.5 SOL: real movement the buy/sell model
    // cannot attribute (aggregator/router pattern). Still rejected.
    const router = parseTradesFromTransactionDetailed(
      rawTx({ wallet: "router", solDelta: 500_000_000, tokenDelta: "1000000" }),
      "TOKEN",
    );
    expect(router.trades).toHaveLength(0);
    expect(router.reason).toBe("router_like_swap");

    // Same pattern at dust scale stays a plain mismatch.
    const dust = parseTradesFromTransactionDetailed(
      rawTx({ wallet: "dust", solDelta: 100, tokenDelta: "1000000" }),
      "TOKEN",
    );
    expect(dust.trades).toHaveLength(0);
    expect(dust.reason).toBe("sol_direction_mismatch");
  });
});

// Synthetic market: flat baseline, one acceleration pump, engineered horizons.
// Times are absolute seconds; buckets are 1s so the detector sees the ramp.
const T0 = 1_000_000;
function mkTrade(wallet: string, timestamp: number, priceSol: number, solAmount = 0.02, type: "buy" | "sell" = "buy", i = 0): Trade {
  return {
    time: new Date(timestamp * 1000).toISOString(),
    timestamp,
    type,
    wallet,
    tokenAmount: solAmount / priceSol,
    solAmount,
    priceSol,
    signature: `sig-${wallet}-${timestamp}-${i}`,
    slot: timestamp,
  };
}

function scenarioTrades(extra: Trade[] = []): Trade[] {
  const trades: Trade[] = [];
  // Dense baseline every 2s from T0-400 right up to the ramp. A pre-pump
  // silence hole is precisely the sparse pattern the coverage guard refuses,
  // so the covered-market scenarios must not contain one.
  let i = 0;
  for (let t = T0 - 400; t <= T0 - 1; t += 2) {
    trades.push(mkTrade("base", t, 1.0, 0.02, "buy", i++));
  }
  // Pre-pump buyer: 1 SOL 40s before the pump start.
  trades.push(mkTrade("EARLY", T0 - 40, 1.0, 1.0, "buy", i++));
  // Acceleration ramp T0..T0+5 (+5%/s) then confirmation level 1.3.
  const ramp = [1.0, 1.05, 1.1, 1.15, 1.2, 1.3];
  ramp.forEach((p, k) => trades.push(mkTrade(`ramp${k}`, T0 + k, p, 0.5, "buy", i++)));
  for (let t = T0 + 6; t <= T0 + 35; t += 1) {
    trades.push(mkTrade("flat", t, 1.3, 0.05, "buy", i++));
  }
  // Early-pump chaser: 1 SOL 6s after start, mid-ramp price.
  trades.push(mkTrade("CHASER", T0 + 6, 1.3, 1.0, "buy", i++));
  trades.push(...extra);
  return trades.sort((a, b) => a.timestamp - b.timestamp || a.slot - b.slot);
}

function fetchShell(trades: Trade[]): FetchResult {
  const drop = {
    accepted_transactions: 0, accepted_trades: 0, failed_transaction: 0, missing_block_time: 0,
    missing_signature: 0, no_token_balance: 0, token_delta_zero: 0, wallet_not_signer: 0,
    missing_wallet_sol_balance: 0, zero_sol_delta: 0, dust_token_delta: 0, sol_direction_mismatch: 0, router_like_swap: 0, invalid_amount: 0,
  };
  return {
    trades, pages: 1, transactionsReturned: trades.length, firstBlockTime: null, lastBlockTime: null, truncated: false,
    lightweightPages: 1, lightweightTransactionsReturned: trades.length, lightweightFirstBlockTime: null,
    lightweightLastBlockTime: null, lightweightTruncated: false, activeWindows: [], quietWindows: [],
    lightweightCacheHit: false, fullCacheHits: 0, fullCacheMisses: 0, fullQueryWindows: 1, parseDropCounts: drop,
  };
}

describe("fresh-artifact skip", () => {
  const NOW = Date.parse("2026-09-20T20:00:00.000Z");
  test("skips fresh artifacts, scans stale ones", () => {
    expect(shouldSkipRescan({ scannedAt: "2026-09-20T19:00:00.000Z" }, NOW, 86400)).toBe(true);
    expect(shouldSkipRescan({ scannedAt: "2026-09-19T19:00:00.000Z" }, NOW, 86400)).toBe(false);
    expect(shouldSkipRescan({ scannedAt: "2026-09-20T19:00:00.000Z", status: "error" }, NOW, 86400)).toBe(true);
  });
  test("fails open to scanning on missing/garbage/disabled", () => {
    expect(shouldSkipRescan(null, NOW, 86400)).toBe(false);
    expect(shouldSkipRescan({}, NOW, 86400)).toBe(false);
    expect(shouldSkipRescan({ scannedAt: "not-a-date" }, NOW, 86400)).toBe(false);
    expect(shouldSkipRescan({ scannedAt: "2026-09-20T19:00:00.000Z" }, NOW, 0)).toBe(false);
  });
});

describe("prospective ranking (no lookahead)", () => {
  test("pre-pump buyer leads on entry evidence; pure chaser is observed but unranked", () => {
    const res = analyzeToken(baseConfig, "TOKEN", fetchShell(scenarioTrades()), { runId: "t", scanStartedAt: "t" });
    expect(res.market.pumpWindows).toBeGreaterThanOrEqual(1);
    expect(res.runId).toBe("t");
    const order = res.walletLeaders.map((l) => l.wallet);
    expect(order).toContain("EARLY");
    const early = res.walletLeaders.find((l) => l.wallet === "EARLY")!;
    expect(early.prePumpPumps).toBeGreaterThanOrEqual(1);
    expect(early.entryEvidenceScore).toBeGreaterThan(0);
    // CHASER bought 6s after start: kept in observations/buy-events for
    // forensics, but structurally unable to outrank a pre-pump wallet.
    expect(order).not.toContain("CHASER");
    expect(res.walletPumpObservations.some((o) => o.wallet === "CHASER")).toBe(true);
    expect(res.pumpBuyEvents.some((e) => e.wallet === "CHASER")).toBe(true);
  });

  test("rank order is invariant to later price action (labels move, ranks do not)", () => {
    const before = analyzeToken(baseConfig, "TOKEN", fetchShell(scenarioTrades()), { runId: "t", scanStartedAt: "t" });
    // Slow post-pump drift as SELLS: fills CHASER's forward30 horizon gap
    // (null -> +8%) without triggering a new pump (too slow for the
    // acceleration gates) and without creating attributions (sells only).
    // Outcome labels move; entry evidence cannot.
    const drift: Trade[] = [];
    for (let t = T0 + 36; t <= T0 + 70; t += 1) {
      drift.push(mkTrade("drift", t, 1.31 + (t - (T0 + 36)) * 0.004, 0.002, "sell", t));
    }
    const after = analyzeToken(baseConfig, "TOKEN", fetchShell(scenarioTrades(drift)), { runId: "t", scanStartedAt: "t" });
    // No new pump window and no new leader from the drift.
    expect(after.market.pumpWindows).toBe(before.market.pumpWindows);
    expect(after.walletLeaders.map((l) => l.wallet)).not.toContain("drift");
    const orderBefore = before.walletLeaders.map((l) => l.wallet);
    const orderAfter = after.walletLeaders.map((l) => l.wallet);
    expect(orderAfter).toEqual(orderBefore);
    // Sanity: the drift really did move an outcome label (null -> value).
    const chaserBefore = before.pumpBuyEvents.filter((e) => e.wallet === "CHASER");
    const chaserAfter = after.pumpBuyEvents.filter((e) => e.wallet === "CHASER");
    expect(chaserAfter.length).toBeGreaterThan(0);
    const fwdBefore = chaserBefore.map((e) => e.forward30);
    const fwdAfter = chaserAfter.map((e) => e.forward30);
    expect(fwdBefore.every((v) => v === null)).toBe(true);
    expect(fwdAfter.some((v) => v !== null)).toBe(true);
  });
});

describe("data-integrity guards (P0)", () => {
  test("dust token amounts quarantine instead of pricing (SH55 pattern)", () => {
    // 1 base unit (6 decimals) against 0.5 SOL: the exact phantom-price shape.
    const dust = parseTradesFromTransactionDetailed(
      rawTx({ wallet: "dust", solDelta: -500_000_000, tokenDelta: "1" }),
      "TOKEN",
      1000,
    );
    expect(dust.trades).toHaveLength(0);
    expect(dust.reason).toBe("dust_token_delta");
    // A real-size move passes the same gate.
    const real = parseTradesFromTransactionDetailed(
      rawTx({ wallet: "real", solDelta: -500_000_000, tokenDelta: "1000000" }),
      "TOKEN",
      1000,
    );
    expect(real.trades).toHaveLength(1);
  });

  test("sparse confirmation refuses the pump instead of inventing it", () => {
    // Ramp fires, then silence: the 5s confirmation target has no bucket
    // within the coverage allowance, so no pump start may be declared.
    const trades: Trade[] = [];
    let i = 0;
    for (let t = T0 - 60; t <= T0 - 1; t += 2) trades.push(mkTrade("base", t, 1.0, 0.02, "buy", i++));
    [1.0, 1.05, 1.1, 1.15, 1.2, 1.3].forEach((p, k) => trades.push(mkTrade(`r${k}`, T0 + k, p, 0.5, "buy", i++)));
    const res = analyzeToken(baseConfig, "TOKEN", fetchShell(trades.sort((a, b) => a.timestamp - b.timestamp)), { runId: "t", scanStartedAt: "t" });
    expect(res.market.pumpWindows).toBe(0);
  });

  test("MFE refuses sparse horizons instead of inventing excursions", () => {
    const trade = mkTrade("W", 1000, 1.0, 1.0, "buy", 0);
    const buckets = [
      { timestamp: 1000, priceSol: 1.0, buySol: 1, sellSol: 0, netBuySol: 1, buyCount: 1, sellCount: 0, tradeCount: 1 },
      { timestamp: 1100, priceSol: 2.0, buySol: 1, sellSol: 0, netBuySol: 1, buyCount: 1, sellCount: 0, tradeCount: 1 },
    ];
    // 100s hole inside a 30s horizon: refuse.
    expect(maxForwardReturnFromTrade(trade, buckets as never, 30)).toBeNull();
    const dense = [];
    for (let t = 1000; t <= 1030; t += 1) {
      dense.push({ timestamp: t, priceSol: 1 + (t - 1000) * 0.01, buySol: 1, sellSol: 0, netBuySol: 1, buyCount: 1, sellCount: 0, tradeCount: 1 });
    }
    const r = maxForwardReturnFromTrade(trade, dense as never, 30);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0.2);
  });

  test("0s, 100s, 200s acceleration chain clusters transitively into one window", () => {
    const trades: Trade[] = [];
    let i = 0;
    // Long quiet baseline so each ramp sees a flat lookback.
    for (let t = T0 - 400; t <= T0 - 1; t += 2) trades.push(mkTrade("base", t, 1.0, 0.02, "buy", i++));
    for (const start of [T0, T0 + 100, T0 + 200]) {
      [1.0, 1.05, 1.1, 1.15, 1.2, 1.3].forEach((p, k) => trades.push(mkTrade(`r${start}-${k}`, start + k, p, 0.5, "buy", i++)));
      // Flat confirmation shelf so the confirm gate sees the level hold.
      for (let t = start + 6; t <= start + 25; t += 1) {
        trades.push(mkTrade("shelf", t, 1.3, 0.05, "buy", i++));
      }
      // Gentle decay back to 1.0 so the next ramp accelerates from flat.
      for (let t = start + 26; t < start + 95; t += 2) {
        const f = 1 - (t - (start + 26)) / 69;
        trades.push(mkTrade("decay", t, 1.3 - 0.3 * (1 - f), 0.01, "sell", i++));
      }
    }
    const res = analyzeToken(baseConfig, "TOKEN", fetchShell(trades.sort((a, b) => a.timestamp - b.timestamp)), { runId: "t", scanStartedAt: "t" });
    expect(res.market.pumpStarts).toBeGreaterThanOrEqual(3);
    expect(res.market.pumpWindows).toBe(1);
    expect(res.pumpWindows[0]!.endTimestamp - res.pumpWindows[0]!.startTimestamp).toBeGreaterThan(150);
  });

  test("insufficient controls NULL the adjusted metrics (never 0.5 prior, never blended rates)", () => {
    // History starts just before the pump: control window is empty.
    const trades: Trade[] = [];
    let i = 0;
    for (let t = T0 - 100; t <= T0 - 1; t += 2) trades.push(mkTrade("base", t, 1.0, 0.02, "buy", i++));
    trades.push(mkTrade("LONE", T0 - 10, 1.0, 1.0, "buy", i++));
    [1.0, 1.05, 1.1, 1.15, 1.2, 1.3].forEach((p, k) => trades.push(mkTrade(`r${k}`, T0 + k, p, 0.5, "buy", i++)));
    for (let t = T0 + 6; t <= T0 + 35; t += 1) trades.push(mkTrade("flat", t, 1.3, 0.05, "buy", i++));
    const res = analyzeToken(baseConfig, "TOKEN", fetchShell(trades.sort((a, b) => a.timestamp - b.timestamp)), { runId: "t", scanStartedAt: "t" });
    expect(res.market.pumpWindows).toBeGreaterThanOrEqual(1);
    for (const o of res.walletPumpObservations) {
      expect(o.controlSufficient).toBe(false);
      expect(o.excessForward30Median).toBeNull();
      expect(o.positive30Lift).toBeNull();
    }
    for (const l of res.walletLeaders) {
      expect(l.controlAdjustedForward30Median).toBeNull();
      expect(l.controlAdjusted30PumpRate).toBeNull();
      expect(l.reliabilityAdjusted30PumpRate).toBeNull();
      expect(l.reliabilityAdjustedExcessForward30Median).toBeNull();
      expect(l.predictiveQualified).toBe(false);
    }
  });

  test("absurd peak windows are flagged and earn no leadership", () => {
    const trades: Trade[] = [];
    let i = 0;
    for (let t = T0 - 400; t <= T0 - 1; t += 2) trades.push(mkTrade("base", t, 1.0, 0.02, "buy", i++));
    // Sane pump first (tracked).
    [1.0, 1.05, 1.1, 1.15, 1.2, 1.3].forEach((p, k) => trades.push(mkTrade(`r${k}`, T0 + k, p, 0.5, "buy", i++)));
    for (let t = T0 + 6; t <= T0 + 200; t += 1) trades.push(mkTrade("flat", t, 1.3, 0.05, "buy", i++));
    // Dense baseline into the artifact zone so coverage cannot refuse it:
    // the absurdity flag (not the coverage guard) must catch this one.
    for (let t = T0 + 201; t <= T0 + 299; t += 2) trades.push(mkTrade("base2", t, 1.3, 0.02, "buy", i++));
    // Dense, funded, still-rising artifact ramp: +5000x with real buy flow.
    for (let t = T0 + 300; t <= T0 + 340; t += 1) {
      trades.push(mkTrade("WHALE", t, 6500 + (t - (T0 + 300)) * 50, 5.0, "buy", i++));
    }
    const res = analyzeToken(baseConfig, "TOKEN", fetchShell(trades.sort((a, b) => a.timestamp - b.timestamp)), { runId: "t", scanStartedAt: "t" });
    expect(res.market.pumpWindows).toBeGreaterThanOrEqual(2);
    const absurd = res.pumpWindows.filter((p) => p.isAbsurd);
    expect(absurd.length).toBeGreaterThanOrEqual(1);
    const absurdIds = new Set(absurd.map((p) => p.id));
    expect(res.walletPumpObservations.every((o) => !absurdIds.has(o.pumpId))).toBe(true);
    // The sane window survives alongside and still attributes leadership.
    expect(res.pumpWindows.some((p) => !p.isAbsurd && !p.isDistribution)).toBe(true);
  });
});
