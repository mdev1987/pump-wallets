import type { Config } from "./config";
import { RESEARCH_VERSION } from "./version";

/**
 * Core pump-wallet analysis engine.
 *
 * This module intentionally contains no filesystem or network code. It receives
 * Helius transactions and converts them into the research datasets used by the
 * rest of the application. A single configured engine is reused for each token.
 */

let CONFIG: Config;

/** Configure the analyzer runtime. Token mint is passed explicitly to parsing functions. */
export function configureAnalyzer(config: Config): void {
  CONFIG = config;
}

export type RawTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
};

export type AccountKey =
  | string
  | {
      pubkey: string;
      signer?: boolean;
      writable?: boolean;
    };

export type RawTransaction = {
  blockTime: number | null;
  slot: number;
  transaction: {
    signatures?: string[];
    message: {
      accountKeys: AccountKey[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
  };
};

export type Trade = {
  time: string;
  timestamp: number;
  type: "buy" | "sell";
  wallet: string;
  tokenAmount: number;
  solAmount: number;
  priceSol: number;
  signature: string;
  slot: number;
};

export type MarketBucket = {
  timestamp: number;
  priceSol: number;
  buySol: number;
  sellSol: number;
  netBuySol: number;
  buyCount: number;
  sellCount: number;
  tradeCount: number;
};

export type PumpCandidate = {
  mode: 'fast' | 'sustained';
  timestamp: number;
  priceSol: number;
  lookbackReturn: number;
  forward30Return: number;
  forward60Return: number;
  confirmBuySol: number;
  volumePace: number;
  buyPressure: number;
};

export type PumpWindow = {
  id: number;
  startTimestamp: number;
  startTime: string;
  endTimestamp: number;
  endTime: string;
  startPriceSol: number;
  peakPriceSol: number;
  peakTimestamp: number;
  peakReturn: number;
  max15sReturn: number;
  max30sReturn: number;
  netBuySol: number;
  buySol: number;
  sellSol: number;
  buyCount: number;
  sellCount: number;
  /** True when window netBuy <= 0: distribution top, not accumulation-led. Not persisted to DuckDB (JSON only). */
  isDistribution?: boolean;
};

export type BuyAttribution = {
  trade: Trade;
  leadPumpId: number | null;
  secondsFromPumpStart: number | null;
  /** Share of pump-window buys visible at the trade timestamp (prospective). */
  pumpBuyFlowShare: number | null;
  /** Share of local-window buys visible at the trade timestamp (prospective). */
  localBuyFlowShare: number | null;
  /** Full-window shares (retrospective forensics; include future buys). */
  fullPumpBuyFlowShare: number | null;
  fullLocalBuyFlowShare: number | null;
  forward1: number | null;
  forward3: number | null;
  forward5: number | null;
  forward10: number | null;
  forward15: number | null;
  forward30: number | null;
  forward60: number | null;
  maxForward15: number | null;
  maxForward30: number | null;
  /** Entry-time feature score. Uses only information available by the buy timestamp. */
  entryEvidenceScore: number;
  /** Retrospective score. May use future forward returns and is never used for prospective ranking. */
  leadEvidenceScore: number;
};

export type WalletLeader = {
  rank: number;
  wallet: string;
  /** Prospective score using entry-time information only. */
  entryEvidenceScore: number;
  /** Retrospective outcome-aware score; descriptive only. */
  leadEvidenceScore: number;
  pumpsLed: number;
  pumpCount: number;
  /** Pumps where this wallet bought strictly before start (secondsFromPumpStart < 0). Ranking key: repeat pre-pump beats chaser-heavy totals. */
  prePumpPumps: number;
  /** Pumps with a sufficient (uncontaminated, large-enough) control baseline. */
  controlBackedPumps: number;
  /**
   * ML-ready flag: repeated (2+) pre-pump pumps AND repeated (2+)
   * control-sufficient pumps. Observations without controls stay in the
   * dataset for forensics but must not train a predictive score.
   */
  predictiveQualified: boolean;
  medianSecondsBeforePump: number | null;
  earliestSecondsBeforePump: number | null;
  avgPumpBuyFlowShare: number | null;
  maxPumpBuyFlowShare: number | null;
  avgLocalBuyFlowShare: number | null;
  maxLocalBuyFlowShare: number | null;
  trades: number;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  netBuySol: number;
  medianTradeSol: number;
  firstBuyTime: string;
  lastBuyTime: string;
  pumpBuys: number;
  pumpBuySol: number;
  prePumpBuys: number;
  prePumpBuySol: number;
  earlyPumpBuyCount: number;
  earlyPumpBuySol: number;
  controlSufficient: boolean;
  controlShortfallReason: string | null;
  lead1sCount: number;
  lead3sCount: number;
  lead5sCount: number;
  lead10sCount: number;
  lead15sCount: number;
  lead1sSol: number;
  lead3sSol: number;
  lead5sSol: number;
  lead10sSol: number;
  lead15sSol: number;
  earlyPumpBuys: number;
  breakoutLeadCount: number;
  breakoutLeadSol: number;
  forward1Median: number | null;
  forward3Median: number | null;
  forward5Median: number | null;
  forward10Median: number | null;
  forward15Median: number | null;
  forward30Median: number | null;
  forward60Median: number | null;
  maxForward15Median: number | null;
  maxForward30Median: number | null;
  forward15PositiveRate: number | null;
  forward30PositiveRate: number | null;
  forward60PositiveRate: number | null;
  forward30LiftVsGlobalMedian: number | null;
  independentPumpCoverage: number;
  positive15PumpRate: number | null;
  positive30PumpRate: number | null;
  positive60PumpRate: number | null;
  meanLeadEvidenceScorePerPump: number | null;
  controlBuyCount: number;
  controlBuySol: number;
  controlAvailableBuyCount: number;
  controlAvailableBuySol: number;
  controlAdjustedForward5Median: number | null;
  controlAdjustedForward15Median: number | null;
  controlAdjustedForward30Median: number | null;
  controlAdjustedForward60Median: number | null;
  controlPositive15Lift: number | null;
  controlPositive30Lift: number | null;
  controlPositive60Lift: number | null;
  controlAdjusted30PumpPositiveCount: number;
  controlAdjusted30PumpRate: number | null;
  reliabilityAdjusted30PumpRate: number | null;
  reliabilityAdjustedExcessForward30Median: number | null;
  qualificationReason: string;
};

export type PumpBuyEventOutput = {
  pumpId: number;
  pumpStartTime: string;
  secondsBeforePump: number;
  time: string;
  timestamp: number;
  wallet: string;
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  signature: string;
  slot: number;
  pumpBuyFlowShare: number;
  localBuyFlowShare: number;
  forward1: number | null;
  forward3: number | null;
  forward5: number | null;
  forward10: number | null;
  forward15: number | null;
  forward30: number | null;
  forward60: number | null;
  maxForward15: number | null;
  maxForward30: number | null;
  entryEvidenceScore: number;
  leadEvidenceScore: number;
};

export type ControlBaseline = {
  pumpId: number;
  pumpStartTime: string;
  windowStartTime: string;
  windowEndTime: string;
  buyCount: number;
  buySol: number;
  availableBuyCount: number;
  availableBuySol: number;
  forward5Median: number | null;
  forward15Median: number | null;
  forward30Median: number | null;
  forward60Median: number | null;
  positive5Rate: number | null;
  positive15Rate: number | null;
  positive30Rate: number | null;
  positive60Rate: number | null;
};

export type WalletPumpObservation = {
  wallet: string;
  pumpId: number;
  pumpStartTime: string;
  pumpEndTime: string;
  pumpReturn: number;
  pumpBuySol: number;
  buyCount: number;
  prePumpBuyCount: number;
  prePumpBuySol: number;
  earlyPumpBuyCount: number;
  earlyPumpBuySol: number;
  controlSufficient: boolean;
  controlShortfallReason: string | null;
  medianSecondsBeforePump: number | null;
  p25SecondsBeforePump: number | null;
  p75SecondsBeforePump: number | null;
  earliestSecondsBeforePump: number | null;
  lead1sCount: number;
  lead3sCount: number;
  lead5sCount: number;
  lead10sCount: number;
  lead15sCount: number;
  lead1sSol: number;
  lead3sSol: number;
  lead5sSol: number;
  lead10sSol: number;
  lead15sSol: number;
  medianPumpBuyFlowShare: number | null;
  maxPumpBuyFlowShare: number | null;
  medianLocalBuyFlowShare: number | null;
  maxLocalBuyFlowShare: number | null;
  forward1Median: number | null;
  forward3Median: number | null;
  forward5Median: number | null;
  forward10Median: number | null;
  forward15Median: number | null;
  forward30Median: number | null;
  forward60Median: number | null;
  maxForward15Median: number | null;
  maxForward30Median: number | null;
  positive15Rate: number | null;
  positive30Rate: number | null;
  positive60Rate: number | null;
  entryEvidenceScore: number;
  leadEvidenceScore: number;
  controlBuyCount: number;
  controlBuySol: number;
  controlAvailableBuyCount: number;
  controlAvailableBuySol: number;
  controlForward5Median: number | null;
  controlForward15Median: number | null;
  controlForward30Median: number | null;
  controlForward60Median: number | null;
  controlPositive15Rate: number | null;
  controlPositive30Rate: number | null;
  controlPositive60Rate: number | null;
  excessForward5Median: number | null;
  excessForward15Median: number | null;
  excessForward30Median: number | null;
  excessForward60Median: number | null;
  positive15Lift: number | null;
  positive30Lift: number | null;
  positive60Lift: number | null;
};

export type TradeFlowIndex = {
  timestamps: number[];
  buySolPrefix: number[];
  sellSolPrefix: number[];
  buyCountPrefix: number[];
  sellCountPrefix: number[];
};

export type AnalysisResponse = {
  version: typeof RESEARCH_VERSION;
  token: string;
  scannedAt: string;
  /**
   * Provenance for multi-run datasets: every row derived from this analysis
   * carries runId across all DuckDB tables, so observations from different
   * scan times are never silently mixed (no time leakage in ML).
   */
  runId: string;
  scanStartedAt: string;
  scanCompletedAt: string;
  source: {
    api: 'helius';
    method: 'getTransactionsForAddress';
    transactionDetails: 'full';
    sortOrder: 'asc';
    tokenAccounts: 'balanceChanged';
  };
  history: {
    scanStrategy: 'adaptive-active-plus-quiet-windows';
    pages: number;
    transactionsReturned: number;
    firstBlockTime: string | null;
    lastBlockTime: string | null;
    truncated: boolean;
    lightweightPages: number;
    lightweightTransactionsReturned: number;
    lightweightFirstBlockTime: string | null;
    lightweightLastBlockTime: string | null;
    lightweightTruncated: boolean;
    activeWindows: Array<ActiveWindowSelection & { startTime: string; endTime: string }>;
    quietWindows: Array<ActiveWindowSelection & { startTime: string; endTime: string }>;
    lightweightCacheHit: boolean;
    fullCacheHits: number;
    fullCacheMisses: number;
    fullQueryWindows: number;
    parseDropCounts: ParseDropCounts;
  };
  market: {
    detectedTrades: number;
    marketBuckets: number;
    pumpStarts: number;
    pumpWindows: number;
  };
  methodology: {
    description: string;
    note: string;
    unitOfAnalysis: string;
    forwardHorizonsSec: number[];
    leadFlowWindowSec: number;
    controlLookbackSec: number;
    controlGapSec: number;
    minControlTradeSol: number;
    maxControlBuysPerPump: number;
    minControlBuysPerPump: number;
    reliabilityPriorPumps: number;
  };
  strongestPump: PumpWindow | null;
  controlBaselines: ControlBaseline[];
  pumpWindows: PumpWindow[];
  walletPumpObservations: WalletPumpObservation[];
  walletLeaders: WalletLeader[];
  pumpBuyEvents: PumpBuyEventOutput[];
};

export type TxOwnerDelta = {
  wallet: string;
  tokenDelta: bigint;
  decimals: number;
  solDeltaLamports: number;
  feePayer: boolean;
};


function getPubkey(key: AccountKey): string {
  return typeof key === "string" ? key : key.pubkey;
}

function getFeePayer(transaction: RawTransaction): string | null {
  const accountKeys = transaction.transaction.message.accountKeys;
  if (!accountKeys.length) return null;

  const signerIndex = accountKeys.findIndex(
    (key) => typeof key !== "string" && key.signer === true,
  );
  const key = accountKeys[signerIndex >= 0 ? signerIndex : 0];
  return key ? getPubkey(key) : null;
}

function getAccountIndexMap(transaction: RawTransaction): Map<string, number> {
  const map = new Map<string, number>();

  for (const [index, key] of transaction.transaction.message.accountKeys.entries()) {
    const pubkey = getPubkey(key);
    if (!map.has(pubkey)) map.set(pubkey, index);
  }

  return map;
}

function getSignerWallets(transaction: RawTransaction): Set<string> {
  const signers = new Set<string>();

  for (const key of transaction.transaction.message.accountKeys) {
    if (typeof key !== 'string' && key.signer === true) {
      signers.add(key.pubkey);
    }
  }

  return signers;
}

function getTokenOwnerDeltas(transaction: RawTransaction, tokenAddress: string): Map<string, {
  tokenDelta: bigint;
  decimals: number;
}> {
  const byAccount = new Map<
    string,
    {
      owner: string;
      pre: bigint;
      post: bigint;
      decimals: number;
    }
  >();

  for (const entry of transaction.meta.preTokenBalances ?? []) {
    if (!entry.owner || entry.mint !== tokenAddress) continue;

    byAccount.set(`${entry.accountIndex}:${entry.mint}`, {
      owner: entry.owner,
      pre: BigInt(entry.uiTokenAmount.amount),
      post: 0n,
      decimals: entry.uiTokenAmount.decimals,
    });
  }

  for (const entry of transaction.meta.postTokenBalances ?? []) {
    if (!entry.owner || entry.mint !== tokenAddress) continue;

    const key = `${entry.accountIndex}:${entry.mint}`;
    const existing = byAccount.get(key);

    if (existing) {
      existing.post = BigInt(entry.uiTokenAmount.amount);
      existing.decimals = entry.uiTokenAmount.decimals;
    } else {
      byAccount.set(key, {
        owner: entry.owner,
        pre: 0n,
        post: BigInt(entry.uiTokenAmount.amount),
        decimals: entry.uiTokenAmount.decimals,
      });
    }
  }

  const byOwner = new Map<string, { tokenDelta: bigint; decimals: number }>();

  for (const balance of byAccount.values()) {
    const delta = balance.post - balance.pre;
    if (delta === 0n) continue;

    const existing = byOwner.get(balance.owner);
    if (existing) {
      existing.tokenDelta += delta;
      existing.decimals = balance.decimals;
    } else {
      byOwner.set(balance.owner, {
        tokenDelta: delta,
        decimals: balance.decimals,
      });
    }
  }

  return byOwner;
}

function bigintToTokenNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export type DetailedParseResult = {
  trades: Trade[];
  reason: ParseDropReason;
};

/**
 * Parse one full Helius transaction and return a primary outcome reason. The
 * reason is intentionally transaction-level so the scanner can diagnose large
 * differences between tokens without retaining rejected payloads.
 */
export function parseTradesFromTransactionDetailed(
  transaction: RawTransaction,
  tokenAddress: string,
): DetailedParseResult {
  if (transaction.blockTime === null) {
    return { trades: [], reason: 'missing_block_time' };
  }
  if (transaction.meta.err !== null) {
    return { trades: [], reason: 'failed_transaction' };
  }

  const signature = transaction.transaction.signatures?.[0];
  if (!signature) {
    return { trades: [], reason: 'missing_signature' };
  }

  const tokenOwners = getTokenOwnerDeltas(transaction, tokenAddress);
  if (tokenOwners.size === 0) {
    return { trades: [], reason: 'no_token_balance' };
  }

  const feePayer = getFeePayer(transaction);
  const signerWallets = getSignerWallets(transaction);
  const accountIndices = getAccountIndexMap(transaction);
  const timestamp = transaction.blockTime;
  const trades: Trade[] = [];

  let sawTokenDelta = false;
  let sawNonZeroTokenDelta = false;
  let sawSignerWallet = false;
  let sawWalletBalance = false;
  let sawSolDelta = false;
  let sawDirectionMismatch = false;
  let sawRouterLikeSwap = false;
  let sawInvalidAmount = false;

  for (const [wallet, token] of tokenOwners) {
    if (token.tokenDelta === 0n) continue;
    sawTokenDelta = true;
    sawNonZeroTokenDelta = true;

    if (!signerWallets.has(wallet) && wallet !== feePayer) continue;
    sawSignerWallet = true;

    const walletIndex = accountIndices.get(wallet);
    if (walletIndex === undefined) continue;

    const preSol = transaction.meta.preBalances[walletIndex];
    const postSol = transaction.meta.postBalances[walletIndex];
    if (preSol === undefined || postSol === undefined) continue;
    sawWalletBalance = true;

    let solDeltaLamports = postSol - preSol;
    if (wallet === feePayer) solDeltaLamports += transaction.meta.fee;
    if (solDeltaLamports === 0) continue;
    sawSolDelta = true;

    let type: 'buy' | 'sell';
    let solAmountLamports: number;

    if (token.tokenDelta > 0n && solDeltaLamports < 0) {
      type = 'buy';
      solAmountLamports = Math.abs(solDeltaLamports);
    } else if (token.tokenDelta < 0n && solDeltaLamports > 0) {
      type = 'sell';
      solAmountLamports = solDeltaLamports;
    } else {
      // Aggregator/router multi-leg swaps move real SOL in a pattern the
      // single-trade buy/sell model cannot attribute (same-sign flows, fee
      // accounts). At/above 0.01 SOL this is signal, not dust: count it
      // separately so router-heavy tokens are diagnosable. Still rejected —
      // no attributable single trade — never silently accepted.
      // Threshold is a lamports constant (not CONFIG) to keep the parser
      // deterministic and usable without analyzer configuration.
      if (Math.abs(solDeltaLamports) >= 10_000_000) sawRouterLikeSwap = true;
      else sawDirectionMismatch = true;
      continue;
    }

    if (!Number.isFinite(solAmountLamports) || solAmountLamports <= 0) {
      sawInvalidAmount = true;
      continue;
    }

    const tokenAmount = bigintToTokenNumber(
      token.tokenDelta < 0n ? -token.tokenDelta : token.tokenDelta,
      token.decimals,
    );
    const solAmount = solAmountLamports / 1e9;
    const priceSol = solAmount / tokenAmount;

    if (
      !Number.isFinite(tokenAmount) || tokenAmount <= 0 ||
      !Number.isFinite(solAmount) || solAmount <= 0 ||
      !Number.isFinite(priceSol) || priceSol <= 0
    ) {
      sawInvalidAmount = true;
      continue;
    }

    trades.push({
      time: new Date(timestamp * 1000).toISOString(),
      timestamp,
      type,
      wallet,
      tokenAmount,
      solAmount,
      priceSol,
      signature,
      slot: transaction.slot,
    });
  }

  if (trades.length > 0) return { trades, reason: 'accepted_transactions' };
  if (!sawNonZeroTokenDelta || !sawTokenDelta) return { trades: [], reason: 'token_delta_zero' };
  if (!sawSignerWallet) return { trades: [], reason: 'wallet_not_signer' };
  if (!sawWalletBalance) return { trades: [], reason: 'missing_wallet_sol_balance' };
  if (!sawSolDelta) return { trades: [], reason: 'zero_sol_delta' };
  if (sawRouterLikeSwap) return { trades: [], reason: 'router_like_swap' };
  if (sawDirectionMismatch) return { trades: [], reason: 'sol_direction_mismatch' };
  if (sawInvalidAmount) return { trades: [], reason: 'invalid_amount' };
  return { trades: [], reason: 'sol_direction_mismatch' };
}

/** Backward-compatible convenience wrapper returning only parsed trades. */
export function parseTradesFromTransaction(
  transaction: RawTransaction,
  tokenAddress: string,
): Trade[] {
  return parseTradesFromTransactionDetailed(transaction, tokenAddress).trades;
}

export type ParseDropReason =
  | 'accepted_transactions'
  | 'accepted_trades'
  | 'failed_transaction'
  | 'missing_block_time'
  | 'missing_signature'
  | 'no_token_balance'
  | 'token_delta_zero'
  | 'wallet_not_signer'
  | 'missing_wallet_sol_balance'
  | 'zero_sol_delta'
  | 'sol_direction_mismatch'
  | 'router_like_swap'
  | 'invalid_amount';

export type ParseDropCounts = Record<ParseDropReason, number>;

export type ActiveWindowSelection = {
  startTimestamp: number;
  endTimestamp: number;
  transactionCount: number;
};

export type FetchResult = {
  /** Compact reconstructed trades retained for analysis; raw Helius pages are discarded immediately. */
  trades: Trade[];
  /** Number of full-transaction pages fetched for the selected active windows. */
  pages: number;
  /** Number of full transactions returned for the selected active windows. */
  transactionsReturned: number;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
  truncated: boolean;
  /** Metadata from the inexpensive signatures-only history scan. */
  lightweightPages: number;
  lightweightTransactionsReturned: number;
  lightweightFirstBlockTime: number | null;
  lightweightLastBlockTime: number | null;
  lightweightTruncated: boolean;
  /** Top activity windows selected for the full transaction stage. */
  activeWindows: ActiveWindowSelection[];
  /** Low-activity reconnaissance windows selected before hot periods. */
  quietWindows: ActiveWindowSelection[];
  /** True when the signatures-only activity scan came from disk cache. */
  lightweightCacheHit: boolean;
  /** Number of completed full-range cache hits. */
  fullCacheHits: number;
  /** Number of full-range cache misses fetched from Helius. */
  fullCacheMisses: number;
  /** Primary parser outcome counts from the full-transaction stage. */
  parseDropCounts: ParseDropCounts;
  /** Number of merged full-transaction time ranges requested from Helius. */
  fullQueryWindows: number;
};

function dedupeTrades(trades: Trade[]): Trade[] {
  const unique = new Map<string, Trade>();

  for (const trade of trades) {
    const key = `${trade.signature}:${trade.wallet}`;
    const existing = unique.get(key);

    if (!existing || trade.slot < existing.slot) {
      unique.set(key, trade);
    }
  }

  return [...unique.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.slot - b.slot,
  );
}

function median(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;

  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[mid - 1]! + finite[mid]!) / 2
    : finite[mid]!;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildTradeFlowIndex(trades: Trade[]): TradeFlowIndex {
  const timestamps: number[] = [];
  const buySolPrefix: number[] = [0];
  const sellSolPrefix: number[] = [0];
  const buyCountPrefix: number[] = [0];
  const sellCountPrefix: number[] = [0];

  for (const trade of trades) {
    timestamps.push(trade.timestamp);
    buySolPrefix.push(
      buySolPrefix.at(-1)! + (trade.type === 'buy' ? trade.solAmount : 0),
    );
    sellSolPrefix.push(
      sellSolPrefix.at(-1)! + (trade.type === 'sell' ? trade.solAmount : 0),
    );
    buyCountPrefix.push(
      buyCountPrefix.at(-1)! + (trade.type === 'buy' ? 1 : 0),
    );
    sellCountPrefix.push(
      sellCountPrefix.at(-1)! + (trade.type === 'sell' ? 1 : 0),
    );
  }

  return {
    timestamps,
    buySolPrefix,
    sellSolPrefix,
    buyCountPrefix,
    sellCountPrefix,
  };
}

function rangeMetrics(
  index: TradeFlowIndex,
  startTimestamp: number,
  endTimestamp: number,
): {
  buySol: number;
  sellSol: number;
  netBuySol: number;
  buyCount: number;
  sellCount: number;
} {
  const lo = lowerBound(index.timestamps, startTimestamp);
  const hi = upperBound(index.timestamps, endTimestamp);

  return {
    buySol: index.buySolPrefix[hi]! - index.buySolPrefix[lo]!,
    sellSol: index.sellSolPrefix[hi]! - index.sellSolPrefix[lo]!,
    netBuySol:
      (index.buySolPrefix[hi]! - index.buySolPrefix[lo]!) -
      (index.sellSolPrefix[hi]! - index.sellSolPrefix[lo]!),
    buyCount: index.buyCountPrefix[hi]! - index.buyCountPrefix[lo]!,
    sellCount: index.sellCountPrefix[hi]! - index.sellCountPrefix[lo]!,
  };
}

function buildMarketBuckets(trades: Trade[]): MarketBucket[] {
  const grouped = new Map<number, Trade[]>();

  for (const trade of trades) {
    if (
      trade.solAmount < CONFIG.minMarketTradeSol ||
      !Number.isFinite(trade.priceSol) ||
      trade.priceSol <= 0
    ) {
      continue;
    }

    const bucket = Math.floor(trade.timestamp / CONFIG.bucketSec) * CONFIG.bucketSec;
    const existing = grouped.get(bucket);

    if (existing) existing.push(trade);
    else grouped.set(bucket, [trade]);
  }

  const buckets: MarketBucket[] = [];

  for (const [timestamp, bucketTrades] of grouped) {
    const prices = bucketTrades.map((trade) => trade.priceSol);
    const priceSol = median(prices);
    if (priceSol === null) continue;

    const buySol = bucketTrades
      .filter((trade) => trade.type === "buy")
      .reduce((sum, trade) => sum + trade.solAmount, 0);
    const sellSol = bucketTrades
      .filter((trade) => trade.type === "sell")
      .reduce((sum, trade) => sum + trade.solAmount, 0);

    buckets.push({
      timestamp,
      priceSol,
      buySol,
      sellSol,
      netBuySol: buySol - sellSol,
      buyCount: bucketTrades.filter((trade) => trade.type === "buy").length,
      sellCount: bucketTrades.filter((trade) => trade.type === "sell").length,
      tradeCount: bucketTrades.length,
    });
  }

  return buckets.sort((a, b) => a.timestamp - b.timestamp);
}

function findPriceAtOrAfter(
  buckets: MarketBucket[],
  targetTimestamp: number,
): MarketBucket | null {
  let lo = 0;
  let hi = buckets.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bucket = buckets[mid]!;

    if (bucket.timestamp < targetTimestamp) lo = mid + 1;
    else hi = mid - 1;
  }

  return buckets[lo] ?? null;
}

function findPriceAtOrBefore(
  buckets: MarketBucket[],
  targetTimestamp: number,
): MarketBucket | null {
  let lo = 0;
  let hi = buckets.length - 1;
  let answer = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bucket = buckets[mid]!;

    if (bucket.timestamp <= targetTimestamp) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return answer >= 0 ? buckets[answer]! : null;
}

function forwardReturnFromTrade(
  trade: Trade,
  buckets: MarketBucket[],
  horizonSec: number,
): number | null {
  // Use the observed execution price of the individual buy as the baseline.
  // The future observation must occur at/after the requested horizon and must
  // not be separated by an excessive market-data gap.
  const future = findPriceAtOrAfter(buckets, trade.timestamp + horizonSec);
  if (!future || trade.priceSol <= 0) return null;

  const observedGap = future.timestamp - trade.timestamp;
  if (observedGap > horizonSec + Math.max(CONFIG.bucketSec * 2, CONFIG.forwardMaxExtraGapSec)) return null;

  return future.priceSol / trade.priceSol - 1;
}

function maxForwardReturnFromTrade(
  trade: Trade,
  buckets: MarketBucket[],
  horizonSec: number,
): number | null {
  if (trade.priceSol <= 0) return null;

  const start = trade.timestamp + CONFIG.bucketSec;
  const end = trade.timestamp + horizonSec;
  let lo = 0;
  let hi = buckets.length - 1;

  // Binary-search the first bucket in the forward interval.
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bucket = buckets[mid]!;
    if (bucket.timestamp < start) lo = mid + 1;
    else hi = mid - 1;
  }

  let maxPrice = trade.priceSol;
  let found = false;

  for (let i = lo; i < buckets.length; i += 1) {
    const bucket = buckets[i]!;
    if (bucket.timestamp > end) break;
    maxPrice = Math.max(maxPrice, bucket.priceSol);
    found = true;
  }

  return found ? maxPrice / trade.priceSol - 1 : null;
}

function windowBuyMetrics(
  flowIndex: TradeFlowIndex,
  startTimestamp: number,
  endTimestamp: number,
): {
  buySol: number;
  sellSol: number;
  netBuySol: number;
  buyCount: number;
  sellCount: number;
} {
  return rangeMetrics(flowIndex, startTimestamp, endTimestamp);
}

function maxForwardReturn(
  buckets: MarketBucket[],
  timestamp: number,
  horizonSec: number,
): number | null {
  const current = findPriceAtOrBefore(buckets, timestamp);
  if (!current) return null;

  const end = timestamp + horizonSec;
  let maxPrice = current.priceSol;

  for (const bucket of buckets) {
    if (bucket.timestamp < timestamp) continue;
    if (bucket.timestamp > end) break;
    maxPrice = Math.max(maxPrice, bucket.priceSol);
  }

  return maxPrice / current.priceSol - 1;
}

function medianFinite(values: number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0
    ? (finite[mid - 1]! + finite[mid]!) / 2
    : finite[mid]!;
}

/**
 * Detect a pump start using both absolute movement and local activity expansion.
 * The fixed return/confirmation guards prevent noise; volume pace and buy
 * pressure adapt to each token's local baseline.
 */
function detectPumpCandidates(
  buckets: MarketBucket[],
  flowIndex: TradeFlowIndex,
): PumpCandidate[] {
  const candidates: PumpCandidate[] = [];
  const volumeByTimestamp = buckets.map((bucket) => bucket.buySol + bucket.sellSol);

  /** Return the median prior volume for a timestamp and lookback interval. */
  const baselineVolume = (timestamp: number, lookbackSec: number): number | null => {
    const values: number[] = [];
    for (let j = buckets.length - 1; j >= 0; j -= 1) {
      const bucket = buckets[j]!;
      if (bucket.timestamp >= timestamp) continue;
      if (bucket.timestamp < timestamp - lookbackSec) break;
      const value = volumeByTimestamp[j]!;
      if (value > 0) values.push(value);
    }
    return medianFinite(values);
  };

  for (let i = 0; i < buckets.length; i += 1) {
    const now = buckets[i]!;

    // Fast vertical move: retains the original scalp-oriented detector.
    const fastLookback = findPriceAtOrBefore(buckets, now.timestamp - CONFIG.pumpLookbackSec);
    const fastConfirm = findPriceAtOrAfter(buckets, now.timestamp + CONFIG.pumpConfirmSec);
    if (fastLookback && fastConfirm) {
      const lookbackReturn = now.priceSol / fastLookback.priceSol - 1;
      const previousLookback = findPriceAtOrBefore(
        buckets,
        fastLookback.timestamp - CONFIG.pumpLookbackSec,
      );
      const priorReturn = previousLookback
        ? fastLookback.priceSol / previousLookback.priceSol - 1
        : 0;
      const baseline = baselineVolume(now.timestamp, CONFIG.pumpBaselineSec);
      const currentVolume = now.buySol + now.sellSol;
      const volumePace = baseline && baseline > 0 ? currentVolume / baseline : null;
      const metrics = windowBuyMetrics(
        flowIndex,
        now.timestamp,
        now.timestamp + CONFIG.pumpConfirmSec,
      );
      const total = metrics.buySol + metrics.sellSol;
      const buyPressure = total > 0 ? metrics.buySol / total : null;
      const forward30Return = fastConfirm.priceSol / now.priceSol - 1;
      const forward60Return = maxForwardReturn(buckets, now.timestamp, CONFIG.forward60Sec) ?? forward30Return;

      if (
        lookbackReturn >= CONFIG.pumpAccelReturn &&
        priorReturn < CONFIG.pumpAccelReturn &&
        forward30Return >= CONFIG.pumpConfirmReturn &&
        metrics.buySol >= CONFIG.pumpMinBuySol &&
        metrics.netBuySol > 0 &&
        volumePace !== null &&
        volumePace >= CONFIG.pumpMinVolumePace &&
        buyPressure !== null &&
        buyPressure >= CONFIG.pumpMinBuyPressure
      ) {
        candidates.push({
          mode: 'fast',
          timestamp: now.timestamp,
          priceSol: now.priceSol,
          lookbackReturn,
          forward30Return,
          forward60Return,
          confirmBuySol: metrics.buySol,
          volumePace,
          buyPressure,
        });
      }
    }

    // Sustained move: catches slower grinds that do not reach the fast gate.
    const sustainedLookback = findPriceAtOrBefore(buckets, now.timestamp - CONFIG.pumpSustainedLookbackSec);
    const sustainedConfirm = findPriceAtOrAfter(buckets, now.timestamp + CONFIG.pumpSustainedConfirmSec);
    if (!sustainedLookback || !sustainedConfirm) continue;

    const sustainedReturn = now.priceSol / sustainedLookback.priceSol - 1;
    const sustainedBaseline = baselineVolume(now.timestamp, CONFIG.pumpBaselineSec);
    const currentVolume = now.buySol + now.sellSol;
    const sustainedVolumePace = sustainedBaseline && sustainedBaseline > 0
      ? currentVolume / sustainedBaseline
      : null;
    const sustainedMetrics = windowBuyMetrics(
      flowIndex,
      now.timestamp,
      now.timestamp + CONFIG.pumpSustainedConfirmSec,
    );
    const sustainedTotal = sustainedMetrics.buySol + sustainedMetrics.sellSol;
    const sustainedBuyPressure = sustainedTotal > 0
      ? sustainedMetrics.buySol / sustainedTotal
      : null;
    const sustainedForwardReturn = sustainedConfirm.priceSol / now.priceSol - 1;

    if (
      sustainedReturn >= CONFIG.pumpSustainedReturn &&
      sustainedForwardReturn >= CONFIG.pumpSustainedConfirmReturn &&
      sustainedMetrics.buySol >= CONFIG.pumpSustainedMinBuySol &&
      sustainedMetrics.netBuySol > 0 &&
      sustainedVolumePace !== null &&
      sustainedVolumePace >= CONFIG.pumpSustainedMinVolumePace &&
      sustainedBuyPressure !== null &&
      sustainedBuyPressure >= CONFIG.pumpSustainedMinBuyPressure
    ) {
      const alreadyFast = candidates.some(
        (candidate) => candidate.timestamp === now.timestamp,
      );
      if (!alreadyFast) {
        candidates.push({
          mode: 'sustained',
          timestamp: now.timestamp,
          priceSol: now.priceSol,
          lookbackReturn: sustainedReturn,
          forward30Return: sustainedForwardReturn,
          forward60Return: maxForwardReturn(buckets, now.timestamp, CONFIG.forward60Sec) ?? sustainedForwardReturn,
          confirmBuySol: sustainedMetrics.buySol,
          volumePace: sustainedVolumePace,
          buyPressure: sustainedBuyPressure,
        });
      }
    }
  }

  candidates.sort((a, b) => a.timestamp - b.timestamp || b.lookbackReturn - a.lookbackReturn);
  return candidates;
}

function buildPumpWindows(
  candidates: PumpCandidate[],
  buckets: MarketBucket[],
  flowIndex: TradeFlowIndex,
): PumpWindow[] {
  if (!candidates.length) return [];

  const windows: PumpWindow[] = [];
  let clusterStart = candidates[0]!;
  let clusterCandidates: PumpCandidate[] = [clusterStart];

  const flush = (): void => {
    const start = clusterCandidates[0]!;
    const endTimestamp = start.timestamp + CONFIG.pumpWindowSec;
    const end = findPriceAtOrBefore(buckets, endTimestamp) ?? buckets.at(-1);
    if (!end) return;

    const peak = buckets
      .filter(
        (bucket) =>
          bucket.timestamp >= start.timestamp &&
          bucket.timestamp <= endTimestamp,
      )
      .reduce(
        (best, bucket) =>
          bucket.priceSol > best.priceSol ? bucket : best,
        buckets.find((bucket) => bucket.timestamp === start.timestamp) ?? end,
      );

    const metrics = windowBuyMetrics(
      flowIndex,
      start.timestamp - CONFIG.prePumpSec,
      end.timestamp,
    );

    const max15 = Math.max(
      ...buckets
        .filter(
          (bucket) =>
            bucket.timestamp >= start.timestamp &&
            bucket.timestamp <= endTimestamp,
        )
        .map(
          (bucket) =>
            maxForwardReturn(buckets, bucket.timestamp, CONFIG.forward15Sec) ?? 0,
        ),
      0,
    );

    const max30 = Math.max(
      ...buckets
        .filter(
          (bucket) =>
            bucket.timestamp >= start.timestamp &&
            bucket.timestamp <= endTimestamp,
        )
        .map(
          (bucket) =>
            maxForwardReturn(buckets, bucket.timestamp, CONFIG.forward30Sec) ?? 0,
        ),
      0,
    );

    windows.push({
      id: windows.length + 1,
      startTimestamp: start.timestamp,
      startTime: new Date(start.timestamp * 1000).toISOString(),
      endTimestamp: end.timestamp,
      endTime: new Date(end.timestamp * 1000).toISOString(),
      startPriceSol: start.priceSol,
      peakPriceSol: peak.priceSol,
      peakTimestamp: peak.timestamp,
      peakReturn: peak.priceSol / start.priceSol - 1,
      max15sReturn: max15,
      max30sReturn: max30,
      netBuySol: metrics.netBuySol,
      buySol: metrics.buySol,
      sellSol: metrics.sellSol,
      buyCount: metrics.buyCount,
      sellCount: metrics.sellCount,
      isDistribution: metrics.netBuySol <= 0,
    });

  };

  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;

    if (candidate.timestamp - clusterStart.timestamp <= CONFIG.pumpClusterSec) {
      clusterCandidates.push(candidate);
    } else {
      flush();
      clusterStart = candidate;
      clusterCandidates = [candidate];
    }
  }

  flush();
  return windows;
}

function nearestPumpForBuy(
  timestamp: number,
  pumpWindows: PumpWindow[],
): { pump: PumpWindow; deltaSec: number } | null {
  let best: { pump: PumpWindow; deltaSec: number } | null = null;

  for (const pump of pumpWindows) {
    const deltaSec = timestamp - pump.startTimestamp;

    if (deltaSec < -CONFIG.prePumpSec || deltaSec > CONFIG.earlyPumpSec) continue;

    if (!best || Math.abs(deltaSec) < Math.abs(best.deltaSec)) {
      best = { pump, deltaSec };
    }
  }

  return best;
}

function sumBuySolInWindow(
  flowIndex: TradeFlowIndex,
  startTimestamp: number,
  endTimestamp: number,
): number {
  const metrics = rangeMetrics(flowIndex, startTimestamp, endTimestamp);
  return metrics.buySol;
}

function timingWeight(secondsFromPumpStart: number): number {
  // Hyperbolic decay keeps 60-120s accumulation visible without treating it
  // as equivalent to an immediate pre-pump entry.
  if (secondsFromPumpStart < 0) {
    const age = -secondsFromPumpStart;
    return 1 / (1 + age / CONFIG.leaderTimingDecaySec);
  }

  if (secondsFromPumpStart <= CONFIG.earlyPumpSec) {
    return 0.5 / (1 + secondsFromPumpStart / CONFIG.leaderTimingDecaySec);
  }

  return 0;
}

function clampResponse(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return clamp(value / CONFIG.leaderResponseScale, -1, 3);
}

/**
 * Entry-time evidence: timing, size and buy-flow shares computed ONLY from
 * buys visible at or before the trade timestamp. No forward returns, no
 * full-window totals. This is the only score allowed into prospective
 * wallet ranking; everything outcome-derived is a label, not a feature.
 */
function computeEntryEvidenceScore(
  trade: Trade,
  secondsFromPumpStart: number | null,
  pumpBuyFlowShareAtEntry: number | null,
  localBuyFlowShareAtEntry: number | null,
): number {
  if (
    trade.type !== 'buy' ||
    trade.solAmount < CONFIG.minLeaderTradeSol ||
    secondsFromPumpStart === null
  ) {
    return 0;
  }

  const timing = timingWeight(secondsFromPumpStart);
  if (timing <= 0) return 0;

  // Keep size important, but sub-linear, so a single 100+ SOL trade cannot
  // completely dominate several smaller but repeatedly well-timed buys.
  const sizeWeight = Math.sqrt(trade.solAmount);
  const flowWeight = 0.5 + 2 * clamp(pumpBuyFlowShareAtEntry ?? 0, 0, 1);
  const localFlowWeight = 0.5 + clamp(localBuyFlowShareAtEntry ?? 0, 0, 1);
  return timing * sizeWeight * flowWeight * localFlowWeight;
}

/** Retrospective descriptive score. Uses future forward returns: never use this as an entry-time feature or ranking input. */
function computeLeadEvidenceScore(
  entryEvidenceScore: number,
  forward5: number | null,
  forward15: number | null,
  forward30: number | null,
): number {
  if (entryEvidenceScore <= 0) return 0;
  const response =
    1 +
    0.25 * clampResponse(forward5) +
    0.35 * clampResponse(forward15) +
    0.40 * clampResponse(forward30);
  return entryEvidenceScore * Math.max(0.25, response);
}

function buildBuyAttributions(
  trades: Trade[],
  buckets: MarketBucket[],
  pumpWindows: PumpWindow[],
  flowIndex: TradeFlowIndex,
): BuyAttribution[] {
  const pumpBuyFlow = new Map<number, number>();

  for (const pump of pumpWindows) {
    const total = sumBuySolInWindow(
      flowIndex,
      pump.startTimestamp - CONFIG.prePumpSec,
      pump.startTimestamp + CONFIG.earlyPumpSec,
    );
    pumpBuyFlow.set(pump.id, total);
  }

  return trades
    .filter((trade) => trade.type === 'buy')
    .map((trade) => {
      const nearest = nearestPumpForBuy(trade.timestamp, pumpWindows);
      // Full-window totals are retrospective forensics (they include buys
      // that happened AFTER this trade). Entry-time shares below use only
      // information available at the trade timestamp.
      const pumpTotalFull = nearest ? pumpBuyFlow.get(nearest.pump.id) ?? 0 : 0;
      const localTotalAtEntry = sumBuySolInWindow(
        flowIndex,
        trade.timestamp - CONFIG.leadFlowWindowSec,
        trade.timestamp,
      );
      const localTotalFull = sumBuySolInWindow(
        flowIndex,
        trade.timestamp - CONFIG.leadFlowWindowSec,
        trade.timestamp + CONFIG.leadFlowWindowSec,
      );
      const pumpTotalAtEntry = nearest
        ? sumBuySolInWindow(
            flowIndex,
            nearest.pump.startTimestamp - CONFIG.prePumpSec,
            Math.min(trade.timestamp, nearest.pump.startTimestamp + CONFIG.earlyPumpSec),
          )
        : 0;
      const pumpShareAtEntry = pumpTotalAtEntry > 0 && nearest
        ? trade.solAmount / pumpTotalAtEntry
        : null;
      const pumpShareFull = pumpTotalFull > 0 && nearest
        ? trade.solAmount / pumpTotalFull
        : null;
      const localShareAtEntry = localTotalAtEntry > 0
        ? trade.solAmount / localTotalAtEntry
        : null;
      const localShareFull = localTotalFull > 0
        ? trade.solAmount / localTotalFull
        : null;
      const entryEvidenceScore = computeEntryEvidenceScore(
        trade,
        nearest?.deltaSec ?? null,
        pumpShareAtEntry,
        localShareAtEntry,
      );

      const forward1 = forwardReturnFromTrade(trade, buckets, CONFIG.forward1Sec);
      const forward3 = forwardReturnFromTrade(trade, buckets, CONFIG.forward3Sec);
      const forward5 = forwardReturnFromTrade(trade, buckets, CONFIG.forward5Sec);
      const forward10 = forwardReturnFromTrade(trade, buckets, CONFIG.forward10Sec);
      const forward15 = forwardReturnFromTrade(trade, buckets, CONFIG.forward15Sec);
      const forward30 = forwardReturnFromTrade(trade, buckets, CONFIG.forward30Sec);
      const forward60 = forwardReturnFromTrade(trade, buckets, CONFIG.forward60Sec);
      const max15 = maxForwardReturnFromTrade(trade, buckets, CONFIG.forward15Sec);
      const max30 = maxForwardReturnFromTrade(trade, buckets, CONFIG.forward30Sec);

      return {
        trade,
        leadPumpId: nearest?.pump.id ?? null,
        secondsFromPumpStart: nearest?.deltaSec ?? null,
        pumpBuyFlowShare: pumpShareAtEntry,
        localBuyFlowShare: localShareAtEntry,
        fullPumpBuyFlowShare: pumpShareFull,
        fullLocalBuyFlowShare: localShareFull,
        forward1,
        forward3,
        forward5,
        forward10,
        forward15,
        forward30,
        forward60,
        maxForward15: max15,
        maxForward30: max30,
        entryEvidenceScore,
        leadEvidenceScore: computeLeadEvidenceScore(
          entryEvidenceScore,
          forward5,
          forward15,
          forward30,
        ),
      };
    });
}

function percentile(values: number[], q: number): number | null {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  if (finite.length === 1) return finite[0]!;

  const position = (finite.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const lower = finite[base]!;
  const upper = finite[base + 1] ?? lower;
  return lower + rest * (upper - lower);
}

function maxOrNull(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function takeEvenly<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) return items;
  if (maxItems <= 1) return items.length ? [items[0]!] : [];

  const selected: T[] = [];
  for (let i = 0; i < maxItems; i += 1) {
    const index = Math.floor((i * (items.length - 1)) / (maxItems - 1));
    const item = items[index];
    if (item !== undefined) selected.push(item);
  }
  return selected;
}

function lowerBoundAttributionTimestamp(
  items: BuyAttribution[],
  targetTimestamp: number,
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (items[mid]!.trade.timestamp < targetTimestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildControlBaselines(
  attributions: BuyAttribution[],
  pumpWindows: PumpWindow[],
): ControlBaseline[] {
  const buys = attributions
    .filter((item) => item.trade.type === 'buy')
    .filter((item) => item.trade.solAmount >= CONFIG.minControlTradeSol);

  const baselines: ControlBaseline[] = [];

  for (const pump of pumpWindows) {
    const startTimestamp = pump.startTimestamp - CONFIG.prePumpSec - CONFIG.controlGapSec - CONFIG.controlLookbackSec;
    const endTimestamp = pump.startTimestamp - CONFIG.prePumpSec - CONFIG.controlGapSec;

    const startIndex = lowerBoundAttributionTimestamp(buys, startTimestamp);
    const endIndex = lowerBoundAttributionTimestamp(buys, endTimestamp);
    const controls = buys
      .slice(startIndex, endIndex)
      .filter((item) => item.leadPumpId === null);

    const selected = takeEvenly(controls, CONFIG.maxControlBuysPerPump);
    const availableBuySol = controls.reduce(
      (sum, item) => sum + item.trade.solAmount,
      0,
    );
    const forward = (field: keyof BuyAttribution): number[] =>
      selected
        .map((item) => item[field])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    baselines.push({
      pumpId: pump.id,
      pumpStartTime: pump.startTime,
      windowStartTime: new Date(startTimestamp * 1000).toISOString(),
      windowEndTime: new Date(endTimestamp * 1000).toISOString(),
      buyCount: selected.length,
      buySol: selected.reduce((sum, item) => sum + item.trade.solAmount, 0),
      availableBuyCount: controls.length,
      availableBuySol,
      forward5Median: median(forward('forward5')),
      forward15Median: median(forward('forward15')),
      forward30Median: median(forward('forward30')),
      forward60Median: median(forward('forward60')),
      positive5Rate: positiveRate(selected.map((item) => item.forward5)),
      positive15Rate: positiveRate(selected.map((item) => item.forward15)),
      positive30Rate: positiveRate(selected.map((item) => item.forward30)),
      positive60Rate: positiveRate(selected.map((item) => item.forward60)),
    });
  }

  return baselines;
}

function buildWalletPumpObservations(
  attributions: BuyAttribution[],
  pumpWindows: PumpWindow[],
  controlBaselines: ControlBaseline[],
): WalletPumpObservation[] {
  const groups = new Map<string, BuyAttribution[]>();
  const baselineByPump = new Map(controlBaselines.map((item) => [item.pumpId, item]));
  // Distribution tops (netBuy <= 0) are violent price events, not buy-driven
  // pumps. Leading one earns no leadership credit: excluded from wallet x pump
  // observations and leaders. Windows, controls and pumpBuyEvents keep them
  // for forensics.
  const distributionPumpIds = new Set(
    pumpWindows.filter((pump) => pump.isDistribution).map((pump) => pump.id),
  );

  for (const item of attributions) {
    if (item.leadPumpId === null || item.entryEvidenceScore <= 0) continue;
    if (distributionPumpIds.has(item.leadPumpId)) continue;
    if (item.trade.solAmount < CONFIG.minLeaderTradeSol) continue;
    if (item.secondsFromPumpStart === null || item.secondsFromPumpStart >= CONFIG.earlyPumpSec) continue;

    const key = `${item.trade.wallet}:${item.leadPumpId}`;
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }

  const observations: WalletPumpObservation[] = [];

  for (const items of groups.values()) {
    const first = items[0]!;
    const pump = pumpWindows.find((candidate) => candidate.id === first.leadPumpId);
    if (!pump) continue;

    const control = baselineByPump.get(pump.id);
    if (!control) continue;
    // Control contamination check: if this pump's control interval overlaps any
    // other pump's pre/early context, remaining "non-leading" buys are still in
    // a pump regime (e.g. pump2 control overlapping pump1 pre-pump). Flag it
    // instead of silently treating excess as clean.
    const controlStart = pump.startTimestamp - CONFIG.prePumpSec - CONFIG.controlGapSec - CONFIG.controlLookbackSec;
    const controlEnd = pump.startTimestamp - CONFIG.prePumpSec - CONFIG.controlGapSec;
    const overlappingPump = pumpWindows.find((other) => {
      if (other.id === pump.id) return false;
      const otherStart = other.startTimestamp - CONFIG.prePumpSec;
      const otherEnd = other.startTimestamp + CONFIG.earlyPumpSec;
      return controlStart <= otherEnd && controlEnd >= otherStart;
    });
    const baseSufficient = control.buyCount >= CONFIG.minControlBuysPerPump;
    const controlSufficient = baseSufficient && !overlappingPump;
    const controlShortfallReason = !baseSufficient
      ? `control buys ${control.buyCount}/${CONFIG.minControlBuysPerPump}`
      : overlappingPump
        ? `control overlaps pump ${overlappingPump.id} context`
        : null;

    const secondsBefore = items
      .map((item) => item.secondsFromPumpStart)
      .filter((value): value is number => value !== null)
      .map((value) => -value);

    const pumpFlows = items
      .map((item) => item.pumpBuyFlowShare)
      .filter((value): value is number => value !== null);
    const localFlows = items
      .map((item) => item.localBuyFlowShare)
      .filter((value): value is number => value !== null);

    const forward = (field: keyof BuyAttribution): number[] =>
      items
        .map((item) => item[field])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    const prePumpItems = items.filter((item) => (item.secondsFromPumpStart ?? 0) < 0);
    const earlyPumpItems = items.filter((item) => (item.secondsFromPumpStart ?? -Infinity) >= 0);
    const preBuySol = prePumpItems.reduce((sum, item) => sum + item.trade.solAmount, 0);
    const earlyBuySol = earlyPumpItems.reduce((sum, item) => sum + item.trade.solAmount, 0);
    const leadAtHorizon = (seconds: number): BuyAttribution[] =>
      items.filter(
        (item) =>
          item.secondsFromPumpStart !== null &&
          item.secondsFromPumpStart >= -seconds &&
          item.secondsFromPumpStart < 0,
      );
    const leadSol = (values: BuyAttribution[]): number =>
      values.reduce((sum, item) => sum + item.trade.solAmount, 0);
    const lead1 = leadAtHorizon(CONFIG.forward1Sec);
    const lead3 = leadAtHorizon(CONFIG.forward3Sec);
    const lead5 = leadAtHorizon(CONFIG.forward5Sec);
    const lead10 = leadAtHorizon(CONFIG.forward10Sec);
    const lead15 = leadAtHorizon(CONFIG.forward15Sec);

    const forward5Median = median(forward('forward5'));
    const forward15Median = median(forward('forward15'));
    const forward30Median = median(forward('forward30'));
    const forward60Median = median(forward('forward60'));
    const positive15 = positiveRate(items.map((item) => item.forward15));
    const positive30 = positiveRate(items.map((item) => item.forward30));
    const positive60 = positiveRate(items.map((item) => item.forward60));

    observations.push({
      wallet: first.trade.wallet,
      pumpId: pump.id,
      pumpStartTime: pump.startTime,
      pumpEndTime: pump.endTime,
      pumpReturn: pump.peakReturn,
      pumpBuySol: pump.buySol,
      buyCount: items.length,
      prePumpBuyCount: prePumpItems.length,
      prePumpBuySol: preBuySol,
      earlyPumpBuyCount: earlyPumpItems.length,
      earlyPumpBuySol: earlyBuySol,
      controlSufficient,
      controlShortfallReason,
      medianSecondsBeforePump: median(secondsBefore),
      p25SecondsBeforePump: percentile(secondsBefore, 0.25),
      p75SecondsBeforePump: percentile(secondsBefore, 0.75),
      earliestSecondsBeforePump: secondsBefore.length ? Math.max(...secondsBefore) : null,
      lead1sCount: lead1.length,
      lead3sCount: lead3.length,
      lead5sCount: lead5.length,
      lead10sCount: lead10.length,
      lead15sCount: lead15.length,
      lead1sSol: leadSol(lead1),
      lead3sSol: leadSol(lead3),
      lead5sSol: leadSol(lead5),
      lead10sSol: leadSol(lead10),
      lead15sSol: leadSol(lead15),
      medianPumpBuyFlowShare: median(pumpFlows),
      maxPumpBuyFlowShare: pumpFlows.length ? Math.max(...pumpFlows) : null,
      medianLocalBuyFlowShare: median(localFlows),
      maxLocalBuyFlowShare: maxOrNull(localFlows),
      forward1Median: median(forward('forward1')),
      forward3Median: median(forward('forward3')),
      forward5Median,
      forward10Median: median(forward('forward10')),
      forward15Median,
      forward30Median,
      forward60Median,
      maxForward15Median: median(forward('maxForward15')),
      maxForward30Median: median(forward('maxForward30')),
      positive15Rate: positive15,
      positive30Rate: positive30,
      positive60Rate: positive60,
      entryEvidenceScore: items.reduce((sum, item) => sum + item.entryEvidenceScore, 0),
      leadEvidenceScore: items.reduce((sum, item) => sum + item.leadEvidenceScore, 0),
      controlBuyCount: control.buyCount,
      controlBuySol: control.buySol,
      controlAvailableBuyCount: control.availableBuyCount,
      controlAvailableBuySol: control.availableBuySol,
      controlForward5Median: control.forward5Median,
      controlForward15Median: control.forward15Median,
      controlForward30Median: control.forward30Median,
      controlForward60Median: control.forward60Median,
      controlPositive15Rate: control.positive15Rate,
      controlPositive30Rate: control.positive30Rate,
      controlPositive60Rate: control.positive60Rate,
      excessForward5Median:
        forward5Median !== null && control.forward5Median !== null
          ? forward5Median - control.forward5Median
          : null,
      excessForward15Median:
        forward15Median !== null && control.forward15Median !== null
          ? forward15Median - control.forward15Median
          : null,
      excessForward30Median:
        forward30Median !== null && control.forward30Median !== null
          ? forward30Median - control.forward30Median
          : null,
      excessForward60Median:
        forward60Median !== null && control.forward60Median !== null
          ? forward60Median - control.forward60Median
          : null,
      positive15Lift:
        positive15 !== null && control.positive15Rate !== null
          ? positive15 - control.positive15Rate
          : null,
      positive30Lift:
        positive30 !== null && control.positive30Rate !== null
          ? positive30 - control.positive30Rate
          : null,
      positive60Lift:
        positive60 !== null && control.positive60Rate !== null
          ? positive60 - control.positive60Rate
          : null,
    });
  }

  return observations.sort(
    (a, b) =>
      a.pumpId - b.pumpId ||
      b.leadEvidenceScore - a.leadEvidenceScore ||
      a.wallet.localeCompare(b.wallet),
  );
}

function positiveRate(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  if (!finite.length) return null;
  return finite.filter((value) => value > 0).length / finite.length;
}

function summarizeWallets(
  trades: Trade[],
  attributions: BuyAttribution[],
  observations: WalletPumpObservation[],
  totalPumpWindows: number,
): WalletLeader[] {
  const byWallet = new Map<string, Trade[]>();
  const observationsByWallet = new Map<string, WalletPumpObservation[]>();
  const prePumpAttributionsByWallet = new Map<string, BuyAttribution[]>();

  for (const trade of trades) {
    const existing = byWallet.get(trade.wallet);
    if (existing) existing.push(trade);
    else byWallet.set(trade.wallet, [trade]);
  }

  for (const observation of observations) {
    const existing = observationsByWallet.get(observation.wallet);
    if (existing) existing.push(observation);
    else observationsByWallet.set(observation.wallet, [observation]);
  }

  for (const item of attributions) {
    if (
      item.leadPumpId !== null &&
      item.secondsFromPumpStart !== null &&
      item.secondsFromPumpStart < 0 &&
      item.entryEvidenceScore > 0
    ) {
      const existing = prePumpAttributionsByWallet.get(item.trade.wallet);
      if (existing) existing.push(item);
      else prePumpAttributionsByWallet.set(item.trade.wallet, [item]);
    }
  }

  const globalForward30 = median(
    attributions
      .map((item) => item.forward30)
      .filter((value): value is number => value !== null),
  );

  const leaders: Omit<WalletLeader, 'rank'>[] = [];

  for (const [wallet, pumpObservations] of observationsByWallet) {
    const walletTrades = byWallet.get(wallet) ?? [];
    const buys = walletTrades.filter((trade) => trade.type === 'buy');
    const sells = walletTrades.filter((trade) => trade.type === 'sell');
    const prePumpItems = prePumpAttributionsByWallet.get(wallet) ?? [];
    // True pre-pump leaders only: pure early-pump chasers (zero buys with
    // secondsFromPumpStart < 0) are excluded here. They remain in
    // pumpBuyEvents for forensics but must not rank as "lead" wallets.
    const prePumpPumps = pumpObservations.filter((o) => o.prePumpBuyCount > 0).length;
    if (prePumpItems.length === 0 || prePumpPumps === 0) continue;

    const buySol = buys.reduce((sum, trade) => sum + trade.solAmount, 0);
    const sellSol = sells.reduce((sum, trade) => sum + trade.solAmount, 0);
    const buySizes = buys.map((trade) => trade.solAmount);

    const observationValues = (
      field: keyof WalletPumpObservation,
    ): number[] =>
      pumpObservations
        .map((item) => item[field])
        .filter(
          (value): value is number =>
            typeof value === 'number' && Number.isFinite(value),
        );

    const leadSeconds = pumpObservations
      .map((item) => item.medianSecondsBeforePump)
      .filter((value): value is number => value !== null);

    const pumpFlows = pumpObservations
      .map((item) => item.medianPumpBuyFlowShare)
      .filter((value): value is number => value !== null);

    const localFlows = pumpObservations
      .map((item) => item.medianLocalBuyFlowShare)
      .filter((value): value is number => value !== null);

    const positive15PumpRate = pumpObservations.length
      ? pumpObservations.filter(
          (item) =>
            (item.positive15Rate ?? 0) >= CONFIG.pumpPositiveRateThreshold,
        ).length / pumpObservations.length
      : null;
    const positive30PumpRate = pumpObservations.length
      ? pumpObservations.filter(
          (item) =>
            (item.positive30Rate ?? 0) >= CONFIG.pumpPositiveRateThreshold,
        ).length / pumpObservations.length
      : null;
    const positive60PumpRate = pumpObservations.length
      ? pumpObservations.filter(
          (item) =>
            (item.positive60Rate ?? 0) >= CONFIG.pumpPositiveRateThreshold,
        ).length / pumpObservations.length
      : null;

    const controlAdjusted30PumpPositiveCount = pumpObservations.filter(
      (item) =>
        item.excessForward30Median !== null &&
        item.excessForward30Median > 0,
    ).length;
    const controlAdjusted30PumpRate = pumpObservations.length
      ? controlAdjusted30PumpPositiveCount / pumpObservations.length
      : null;
    const reliabilityAdjusted30PumpRate = pumpObservations.length
      ? (controlAdjusted30PumpPositiveCount + 0.5 * CONFIG.reliabilityPriorPumps) /
        (pumpObservations.length + CONFIG.reliabilityPriorPumps)
      : null;

    const totalEntryEvidenceScore = pumpObservations.reduce(
      (sum, item) => sum + item.entryEvidenceScore,
      0,
    );
    const totalLeadEvidenceScore = pumpObservations.reduce(
      (sum, item) => sum + item.leadEvidenceScore,
      0,
    );

    const firstBuy = buys.at(0);
    const lastBuy = buys.at(-1);
    if (!firstBuy || !lastBuy) continue;

    const medianLeadSec = median(leadSeconds);
    const medianFlow = median(pumpFlows);
    const medianLocalFlow = median(localFlows);
    const forward30Median = median(observationValues('forward30Median'));
    const controlAdjustedForward30Median = median(
      observationValues('excessForward30Median'),
    );
    const controlAdjustedForward15Median = median(
      observationValues('excessForward15Median'),
    );
    const controlAdjustedForward5Median = median(
      observationValues('excessForward5Median'),
    );
    const controlAdjustedForward60Median = median(
      observationValues('excessForward60Median'),
    );
    const reliabilityFactor = pumpObservations.length /
      (pumpObservations.length + CONFIG.reliabilityPriorPumps);
    const reliabilityAdjustedExcessForward30Median =
      controlAdjustedForward30Median === null
        ? null
        : controlAdjustedForward30Median * reliabilityFactor;
    const controlPositive15Lift = median(observationValues('positive15Lift'));
    const controlPositive30Lift = median(observationValues('positive30Lift'));
    const controlPositive60Lift = median(observationValues('positive60Lift'));
    const controlBuyCount = pumpObservations.reduce(
      (sum, item) => sum + item.controlBuyCount,
      0,
    );
    const controlBuySol = pumpObservations.reduce(
      (sum, item) => sum + item.controlBuySol,
      0,
    );
    const controlAvailableBuyCount = pumpObservations.reduce(
      (sum, item) => sum + item.controlAvailableBuyCount,
      0,
    );
    const controlAvailableBuySol = pumpObservations.reduce(
      (sum, item) => sum + item.controlAvailableBuySol,
      0,
    );
    const forward30LiftVsGlobalMedian =
      forward30Median !== null && globalForward30 !== null
        ? forward30Median - globalForward30
        : null;

    const controlBackedPumps = pumpObservations.filter((item) => item.controlSufficient).length;
    // Token-local research qualification: repeated pre-pump evidence plus
    // repeated control-sufficient evidence within this token. Cross-token
    // repetition is evaluated separately in wallet_global_summary.
    const predictiveQualified = prePumpPumps >= 2 && controlBackedPumps >= 2;
    const totalPrePumpBuySol = pumpObservations.reduce((sum, item) => sum + item.prePumpBuySol, 0);
    const dustFlag = totalPrePumpBuySol < 0.5 ? `dust pre-pump ${totalPrePumpBuySol.toFixed(3)} SOL` : `pre-pump ${totalPrePumpBuySol.toFixed(2)} SOL`;
    const medianLeadFlag = medianLeadSec === null
      ? 'lead timing n/a'
      : medianLeadSec <= 0
        ? `median CHASER +${(-medianLeadSec).toFixed(1)}s after start`
        : `median lead ${medianLeadSec.toFixed(1)}s`;
    const reasons = [
      `${pumpObservations.length} independent pump window${pumpObservations.length === 1 ? '' : 's'} (${prePumpPumps} with pre-pump buys)`,
      medianLeadFlag,
      dustFlag,
      controlAdjustedForward30Median === null
        ? 'control-adjusted 30s response n/a'
        : `median 30s excess ${(controlAdjustedForward30Median * 100).toFixed(2)}%`,
      pumpObservations.some((item) => !item.controlSufficient)
        ? `control-backed on ${controlBackedPumps}/${pumpObservations.length} pumps`
        : 'control baseline sufficient',
      predictiveQualified
        ? 'predictive-qualified (repeated pre-pump + repeated control-backed evidence)'
        : 'observational only (needs repeated pre-pump + repeated control-backed evidence)',
      controlPositive30Lift === null
        ? 'control 30s positive-rate lift n/a'
        : `median 30s positive-rate lift ${(controlPositive30Lift * 100).toFixed(1)}pp`,
      medianFlow === null
        ? 'pump-flow share n/a'
        : `median pump-flow share ${(medianFlow * 100).toFixed(2)}%`,
      reliabilityAdjustedExcessForward30Median === null
        ? 'reliability-adjusted 30s excess n/a'
        : `reliability-adjusted 30s excess ${(reliabilityAdjustedExcessForward30Median * 100).toFixed(2)}%`,
    ];

    leaders.push({
      wallet,
      entryEvidenceScore: totalEntryEvidenceScore,
      leadEvidenceScore: totalLeadEvidenceScore,
      pumpsLed: pumpObservations.length,
      pumpCount: pumpObservations.length,
      prePumpPumps,
      controlBackedPumps,
      predictiveQualified,
      medianSecondsBeforePump: medianLeadSec,
      earliestSecondsBeforePump: leadSeconds.length ? Math.max(...leadSeconds) : null,
      avgPumpBuyFlowShare: medianFlow,
      maxPumpBuyFlowShare: maxOrNull(
        pumpObservations
          .map((item) => item.maxPumpBuyFlowShare)
          .filter((value): value is number => value !== null),
      ),
      avgLocalBuyFlowShare: medianLocalFlow,
      maxLocalBuyFlowShare: maxOrNull(
        pumpObservations
          .map((item) => item.maxLocalBuyFlowShare)
          .filter((value): value is number => value !== null),
      ),
      trades: walletTrades.length,
      buys: buys.length,
      sells: sells.length,
      buySol,
      sellSol,
      netBuySol: buySol - sellSol,
      medianTradeSol: median(buySizes) ?? 0,
      firstBuyTime: firstBuy.time,
      lastBuyTime: lastBuy.time,
      pumpBuys: pumpObservations.reduce((sum, item) => sum + item.buyCount, 0),
      // Total pump-window SOL (pre + early). Previously summed pre-only while
      // named pumpBuySol, understating chaser-heavy wallets.
      pumpBuySol: pumpObservations.reduce((sum, item) => sum + item.prePumpBuySol + item.earlyPumpBuySol, 0),
      prePumpBuys: prePumpItems.length,
      prePumpBuySol: prePumpItems.reduce(
        (sum, item) => sum + item.trade.solAmount,
        0,
      ),
      lead1sCount: pumpObservations.reduce((sum, item) => sum + item.lead1sCount, 0),
      lead3sCount: pumpObservations.reduce((sum, item) => sum + item.lead3sCount, 0),
      lead5sCount: pumpObservations.reduce((sum, item) => sum + item.lead5sCount, 0),
      lead10sCount: pumpObservations.reduce((sum, item) => sum + item.lead10sCount, 0),
      lead15sCount: pumpObservations.reduce((sum, item) => sum + item.lead15sCount, 0),
      lead1sSol: pumpObservations.reduce((sum, item) => sum + item.lead1sSol, 0),
      lead3sSol: pumpObservations.reduce((sum, item) => sum + item.lead3sSol, 0),
      lead5sSol: pumpObservations.reduce((sum, item) => sum + item.lead5sSol, 0),
      lead10sSol: pumpObservations.reduce((sum, item) => sum + item.lead10sSol, 0),
      lead15sSol: pumpObservations.reduce((sum, item) => sum + item.lead15sSol, 0),
      earlyPumpBuyCount: pumpObservations.reduce((sum, item) => sum + item.earlyPumpBuyCount, 0),
      controlSufficient: pumpObservations.every((item) => item.controlSufficient),
      controlShortfallReason: (() => {
        const reasons = pumpObservations
          .map((item) => item.controlShortfallReason)
          .filter((value): value is string => value !== null);
        return reasons.length ? reasons.join(' | ') : null;
      })(),
      earlyPumpBuys: pumpObservations.reduce((sum, item) => sum + item.earlyPumpBuyCount, 0),
      earlyPumpBuySol: pumpObservations.reduce((sum, item) => sum + item.earlyPumpBuySol, 0),
      breakoutLeadCount: prePumpItems.length,
      breakoutLeadSol: prePumpItems.reduce(
        (sum, item) => sum + item.trade.solAmount,
        0,
      ),
      forward1Median: median(observationValues('forward1Median')),
      forward3Median: median(observationValues('forward3Median')),
      forward5Median: median(observationValues('forward5Median')),
      forward10Median: median(observationValues('forward10Median')),
      forward15Median: median(observationValues('forward15Median')),
      forward30Median,
      forward60Median: median(observationValues('forward60Median')),
      maxForward15Median: median(observationValues('maxForward15Median')),
      maxForward30Median: median(observationValues('maxForward30Median')),
      forward15PositiveRate: median(observationValues('positive15Rate')),
      forward30PositiveRate: median(observationValues('positive30Rate')),
      forward60PositiveRate: median(observationValues('positive60Rate')),
      forward30LiftVsGlobalMedian,
      independentPumpCoverage:
        totalPumpWindows > 0 ? pumpObservations.length / totalPumpWindows : 0,
      positive15PumpRate,
      positive30PumpRate,
      positive60PumpRate,
      meanLeadEvidenceScorePerPump: pumpObservations.length
        ? totalLeadEvidenceScore / pumpObservations.length
        : null,
      controlBuyCount,
      controlBuySol,
      controlAvailableBuyCount,
      controlAvailableBuySol,
      controlAdjustedForward5Median,
      controlAdjustedForward15Median,
      controlAdjustedForward30Median,
      controlAdjustedForward60Median,
      controlPositive15Lift,
      controlPositive30Lift,
      controlPositive60Lift,
      controlAdjusted30PumpPositiveCount,
      controlAdjusted30PumpRate,
      reliabilityAdjusted30PumpRate,
      reliabilityAdjustedExcessForward30Median,
      qualificationReason: reasons.join('; '),
    });
  }

  // Prospective/event-conditioned ranking only. Future outcome metrics
  // (reliability-adjusted excess, positive lifts, forward-based scores) are
  // labels for post-hoc evaluation, never ranking inputs — ranking on them
  // would leak future price action into a supposedly predictive order.
  // Positive pre-pump count is the primary recurrence signal.
  leaders.sort(
    (a, b) =>
      b.prePumpPumps - a.prePumpPumps ||
      b.controlBackedPumps - a.controlBackedPumps ||
      b.entryEvidenceScore - a.entryEvidenceScore ||
      b.prePumpBuySol - a.prePumpBuySol ||
      (b.medianSecondsBeforePump ?? Number.NEGATIVE_INFINITY) -
        (a.medianSecondsBeforePump ?? Number.NEGATIVE_INFINITY) ||
      b.pumpsLed - a.pumpsLed ||
      a.wallet.localeCompare(b.wallet),
  );

  return leaders.map((leader, index) => ({
    rank: index + 1,
    ...leader,
  }));
}

export function selectStrongestPump(pumpWindows: PumpWindow[]): PumpWindow | null {
  if (!pumpWindows.length) return null;

  // Prefer accumulation-led pumps (netBuy > 0). A distribution top with
  // negative netBuy (e.g. pump 5 live: -2.5 SOL, +267%) must not outrank a
  // genuine accumulation pump on peakReturn alone.
  return [...pumpWindows].sort(
    (a, b) => {
      const aDist = a.netBuySol <= 0 ? 1 : 0;
      const bDist = b.netBuySol <= 0 ? 1 : 0;
      return (
        aDist - bDist ||
        b.peakReturn - a.peakReturn ||
        b.max30sReturn - a.max30sReturn ||
        b.netBuySol - a.netBuySol ||
        a.startTimestamp - b.startTimestamp
      );
    },
  )[0] ?? null;
}

/**
 * Analyze one token's already-fetched historical transactions.
 *
 * Network access and persistence are deliberately kept outside this function so
 * the same deterministic analysis can be applied to many tokens and tested from
 * fixtures without touching Helius or DuckDB.
 */
export function analyzeToken(
  config: Config,
  tokenAddress: string,
  fetchResult: FetchResult,
  run?: { runId: string; scanStartedAt: string },
): AnalysisResponse {
  configureAnalyzer(config);
  const runId = run?.runId ?? 'adhoc';
  const scanStartedAt = run?.scanStartedAt ?? new Date().toISOString();

  // Helius pages are parsed before this function is called. Only the compact
  // Trade[] is retained, which keeps memory roughly proportional to actual
  // market trades rather than full transaction payloads.
  const trades = dedupeTrades(fetchResult.trades).filter(
    (trade) =>
      Number.isFinite(trade.solAmount) &&
      trade.solAmount > 0 &&
      Number.isFinite(trade.priceSol) &&
      trade.priceSol > 0,
  );

  const marketBuckets = buildMarketBuckets(trades);
  const flowIndex = buildTradeFlowIndex(trades);
  const candidates = detectPumpCandidates(marketBuckets, flowIndex);
  const pumpWindows = buildPumpWindows(candidates, marketBuckets, flowIndex);
  const attributions = buildBuyAttributions(
    trades,
    marketBuckets,
    pumpWindows,
    flowIndex,
  );
  const controlBaselines = buildControlBaselines(attributions, pumpWindows);
  const observations = buildWalletPumpObservations(
    attributions,
    pumpWindows,
    controlBaselines,
  );
  const leaders = summarizeWallets(
    trades,
    attributions,
    observations,
    pumpWindows.length,
  );
  const strongestPump = selectStrongestPump(pumpWindows);


  return {
    version: RESEARCH_VERSION,
    token: tokenAddress,
    scannedAt: new Date().toISOString(),
    runId,
    scanStartedAt,
    scanCompletedAt: new Date().toISOString(),
    source: {
      api: 'helius',
      method: 'getTransactionsForAddress',
      transactionDetails: 'full',
      sortOrder: 'asc',
      tokenAccounts: 'balanceChanged',
    },
    history: {
      scanStrategy: 'adaptive-active-plus-quiet-windows',
      pages: fetchResult.pages,
      transactionsReturned: fetchResult.transactionsReturned,
      firstBlockTime: fetchResult.firstBlockTime === null
        ? null
        : new Date(fetchResult.firstBlockTime * 1000).toISOString(),
      lastBlockTime: fetchResult.lastBlockTime === null
        ? null
        : new Date(fetchResult.lastBlockTime * 1000).toISOString(),
      truncated: fetchResult.truncated,
      lightweightPages: fetchResult.lightweightPages,
      lightweightTransactionsReturned: fetchResult.lightweightTransactionsReturned,
      lightweightFirstBlockTime: fetchResult.lightweightFirstBlockTime === null
        ? null
        : new Date(fetchResult.lightweightFirstBlockTime * 1000).toISOString(),
      lightweightLastBlockTime: fetchResult.lightweightLastBlockTime === null
        ? null
        : new Date(fetchResult.lightweightLastBlockTime * 1000).toISOString(),
      lightweightTruncated: fetchResult.lightweightTruncated,
      activeWindows: fetchResult.activeWindows.map((window) => ({
        ...window,
        startTime: new Date(window.startTimestamp * 1000).toISOString(),
        endTime: new Date(window.endTimestamp * 1000).toISOString(),
      })),
      quietWindows: fetchResult.quietWindows.map((window) => ({
        ...window,
        startTime: new Date(window.startTimestamp * 1000).toISOString(),
        endTime: new Date(window.endTimestamp * 1000).toISOString(),
      })),
      lightweightCacheHit: fetchResult.lightweightCacheHit,
      fullCacheHits: fetchResult.fullCacheHits,
      fullCacheMisses: fetchResult.fullCacheMisses,
      fullQueryWindows: fetchResult.fullQueryWindows,
      parseDropCounts: fetchResult.parseDropCounts,
    },
    market: {
      detectedTrades: trades.length,
      marketBuckets: marketBuckets.length,
      pumpStarts: candidates.length,
      pumpWindows: pumpWindows.length,
    },
    methodology: {
      description:
        'Historical scanning first uses signatures-only activity discovery to select the busiest short activity windows plus a small set of lower-activity pre-spike reconnaissance windows, then fetches full Helius transaction payloads only for the union of those ranges. Overlapping ranges are merged before splitting, and dense unions are recursively split using already-collected fine activity counts; there is no arbitrary first-N-page truncation. The primary research unit is wallet × independent pump window. Wallet evidence combines pre-pump timing, repeated leadership across independent windows, local/pump-window buy-flow share, forward price response from each buy execution, and a nearby non-leading-buy control baseline.',
      note:
        'These are temporal/market-association signals, not proof that a wallet caused the pump or had causal price impact. Control baselines use same-token buys sufficiently before the pre-pump window and outside other detected pump contexts; when many controls exist, they are deterministically thinned across the control interval. Excess response is descriptive, not causal. Wallet ranking uses entry-time evidence only (timing, size, at-entry flow shares); forward and control-adjusted outcomes are stored as evaluation labels, never ranking inputs.',
      unitOfAnalysis: 'wallet × independent pump window',
      forwardHorizonsSec: [
        config.forward1Sec,
        config.forward3Sec,
        config.forward5Sec,
        config.forward10Sec,
        config.forward15Sec,
        config.forward30Sec,
        config.forward60Sec,
      ],
      leadFlowWindowSec: config.leadFlowWindowSec,
      controlLookbackSec: config.controlLookbackSec,
      controlGapSec: config.controlGapSec,
      minControlTradeSol: config.minControlTradeSol,
      maxControlBuysPerPump: config.maxControlBuysPerPump,
      minControlBuysPerPump: config.minControlBuysPerPump,
      reliabilityPriorPumps: config.reliabilityPriorPumps,
    },
    strongestPump,
    controlBaselines,
    pumpWindows,
    walletPumpObservations: observations,
    // Keep every candidate in the per-token artifact so the global DuckDB can
    // perform cross-token research without silently dropping lower-ranked rows.
    walletLeaders: leaders,
    pumpBuyEvents: attributions
      .filter((item) => item.leadPumpId !== null && item.entryEvidenceScore > 0)
      .sort(
        (a, b) =>
          b.leadEvidenceScore - a.leadEvidenceScore ||
          a.trade.timestamp - b.trade.timestamp,
      )
      .map((item) => {
        const pump = pumpWindows.find((candidate) => candidate.id === item.leadPumpId);
        if (!pump || item.secondsFromPumpStart === null) return null;
        return {
          pumpId: pump.id,
          pumpStartTime: pump.startTime,
          secondsBeforePump: -item.secondsFromPumpStart,
          time: item.trade.time,
          timestamp: item.trade.timestamp,
          wallet: item.trade.wallet,
          solAmount: item.trade.solAmount,
          tokenAmount: item.trade.tokenAmount,
          priceSol: item.trade.priceSol,
          signature: item.trade.signature,
          slot: item.trade.slot,
          pumpBuyFlowShare: item.pumpBuyFlowShare ?? 0,
          localBuyFlowShare: item.localBuyFlowShare ?? 0,
          forward1: item.forward1,
          forward3: item.forward3,
          forward5: item.forward5,
          forward10: item.forward10,
          forward15: item.forward15,
          forward30: item.forward30,
          forward60: item.forward60,
          maxForward15: item.maxForward15,
          maxForward30: item.maxForward30,
          entryEvidenceScore: item.entryEvidenceScore,
          leadEvidenceScore: item.leadEvidenceScore,
        } satisfies PumpBuyEventOutput;
      })
      .filter((item): item is PumpBuyEventOutput => item !== null),
  };
}
