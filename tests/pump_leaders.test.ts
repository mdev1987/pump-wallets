import { describe, expect, test } from "bun:test";
import {
  analyzeToken,
  parseTradesFromTransactionDetailed,
  type FetchResult,
  type RawTransaction,
  type Trade,
} from "../src/analyzer";

const baseConfig = {
  heliusApiKey: "x", heliusRpcBaseUrl: "x", heliusPageLimit: 100, maxHistoryPages: 100,
  heliusLightPageLimit: 1000, maxLightHistoryPages: 100, maxLightSignatures: 10000, activityBucketSec: 60,
  activeWindowSec: 300, activeWindowCount: 1, minActiveWindowTransactions: 1, activeWindowContextSec: 0,
  activeWindowMergeGapSec: 0, fullWindowMergeGapSec: 0, quietWindowSec: 60, quietWindowCount: 0,
  minQuietWindowTransactions: 0, quietSearchStartSec: 60, quietSearchEndSec: 120, quietWindowContextSec: 0,
  fineActivityBucketSec: 30, maxFullTransactionsPerWindow: 1000, maxFullQueryWindows: 10, heliusCacheEnabled: false,
  heliusCacheDir: "./data/cache", heliusLightCacheTtlSec: 0, heliusFullCacheTtlSec: 0, heliusMinIntervalMs: 0, retryAttempts: 1, retryBackoffMs: 1,
  minMarketTradeSol: 0.001, minLeaderTradeSol: 0.01, bucketSec: 1, pumpLookbackSec: 5, pumpAccelReturn: 0.09,
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
  // Baseline buys every 2s from T0-400 to T0-41 (control window + baseline).
  let i = 0;
  for (let t = T0 - 400; t <= T0 - 41; t += 2) {
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
    missing_wallet_sol_balance: 0, zero_sol_delta: 0, sol_direction_mismatch: 0, router_like_swap: 0, invalid_amount: 0,
  };
  return {
    trades, pages: 1, transactionsReturned: trades.length, firstBlockTime: null, lastBlockTime: null, truncated: false,
    lightweightPages: 1, lightweightTransactionsReturned: trades.length, lightweightFirstBlockTime: null,
    lightweightLastBlockTime: null, lightweightTruncated: false, activeWindows: [], quietWindows: [],
    lightweightCacheHit: false, fullCacheHits: 0, fullCacheMisses: 0, fullQueryWindows: 1, parseDropCounts: drop,
  };
}

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
