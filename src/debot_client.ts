/**
 * DeBot community-signal client — final candidate-generation module.
 *
 * DeBot's job in the broader project is intentionally narrow:
 *   1. Find tokens that are unusually active now.
 *   2. Separate current activity from pump-precursor evidence.
 *   3. Preserve raw 1m/5m/heatmap evidence for later Helius validation.
 *
 * Helius remains the source of truth for transaction-level pump and wallet
 * analysis. DeBot scores must not be interpreted as proof of causality.
 *
 * The client uses three public community-signal endpoints:
 *   - /activity/rank?duration=1m : very short-term activity.
 *   - /activity/rank?duration=5m : recent persistence/context.
 *   - /heatmap                  : 10-minute market/tokens context.
 */

export type DeBotDuration = "1m" | "5m";

export type DeBotScoreWeights = {
  // Activity score: describes how active the token is now.
  activityRank1m: number;
  activityRank5m: number;
  activityIntensity: number;

  // Pump precursor score: directional + short-term acceleration evidence.
  buyPressure1m: number;
  buyPressureDelta: number;
  volumeAcceleration: number;
  walletAcceleration: number;
};

export type DeBotClientConfig = {
  baseUrl: string;
  chain: string;
  rankLimit: number;
  requestTimeoutMs: number;
  apiKey?: string;
  pollIntervalMs: number;
  candidateLimit: number;
  minPumpPrecursorScore: number;
  minPumpPrecursorEvidence: number;
  minPumpPrecursorPositiveEvidence: number;
  minActivityScore: number;
  minActivityEvidence: number;
  minVolumeAcceleration: number;
  require1m: boolean;
  include1mOnly: boolean;

  // These values are only used to normalize/finalize scores.
  accelerationSaturation: number;
  activityScoreSaturation: number;
  buyPressureDeltaSaturation: number;

  // Heatmap is context, never a hard pump gate by default.
  requireHeatmap: boolean;
  maxHeatmapRecencySec: number;

  retryAttempts: number;
  retryBackoffMs: number;
  scoreWeights: DeBotScoreWeights;
};

type DeBotResponse<T> = {
  code: number;
  description?: string;
  data: T;
};

type DeBotDex = { dex_name?: string; dex_index?: number };

type DeBotBaseToken = {
  asset_type?: string;
  chain?: string;
  symbol?: string;
  decimal?: number;
  name?: string;
  address?: string;
  reserve?: string;
};

type DeBotMarketInfo = {
  price?: number;
  holders?: number;
  fdv?: number;
  mkt_cap?: number;
  percent?: number;
  percent_5m?: number;
  percent_1h?: number;
  percent_24h?: number;
  buys?: number;
  sells?: number;
  swaps?: number;
  buy_volume?: number;
  sell_volume?: number;
  volume?: number;
  uniq_wallet_swaps?: number;
  uniq_wallet_swaps_1h?: number;
  last_update_time?: number;
};

type DeBotPairSummaryInfo = { liquidity?: number };

type DeBotSafeInfo = {
  solana?: {
    is_mint_abandoned?: number;
    is_block_address?: number;
  };
};

/** Raw token record returned by DeBot activity rank. */
export type DeBotActivityRankItem = {
  address: string;
  creator_address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logo?: string;
  total_supply?: number;
  launchpad?: string;
  creation_timestamp?: number;
  chain?: string;
  pair?: string;
  dex?: DeBotDex;
  base_token?: DeBotBaseToken;
  market_info?: DeBotMarketInfo;
  pair_summary_info?: DeBotPairSummaryInfo;
  safe_info?: DeBotSafeInfo;
  tags?: string[] | null;
  from_launchpad?: boolean;
  smart_wallet_online_count?: number;
  smart_wallet_total_count?: number;
  max_price_gain?: number;
  token_tier?: string;
  activity_score?: number;
  social_info?: Record<string, unknown> | null;
};

export type DeBotActivityRankResponse = {
  code: number;
  description?: string;
  data: DeBotActivityRankItem[];
};

/** Token-level signal metadata from heatmap.meta.signals. */
export type DeBotHeatmapMetaSignal = {
  signal_count?: number;
  first_time?: number;
  first_price?: number;
  max_price?: number;
  max_price_gain?: number;
  signal_tags?: string[] | null;
  token_level?: string;
};

/** One ten-minute market heatmap bucket. */
export type DeBotHeatmapBucket = {
  time: number;
  wallet_count: number;
  trade_volume: number;
  tokens: string[];
};

export type DeBotHeatmapData = {
  meta: { signals: Record<string, DeBotHeatmapMetaSignal> };
  heatmap: DeBotHeatmapBucket[];
};

export type DeBotHeatmapResponse = DeBotResponse<DeBotHeatmapData>;

/** Market/token context derived from heatmap data. */
export type DeBotHeatmapContext = {
  heatmapSeen: boolean;
  heatmapOccurrenceCount: number;
  heatmapFirstSeenSec: number | null;
  heatmapLastSeenSec: number | null;
  heatmapRecencySec: number | null;
  latestMarketWalletCount: number | null;
  latestMarketTradeVolume: number | null;
  previousMarketWalletCount: number | null;
  previousMarketTradeVolume: number | null;
  marketWalletAcceleration: number | null;
  marketVolumeAcceleration: number | null;
  signalCount: number | null;
  signalFirstTimeSec: number | null;
  signalFirstPrice: number | null;
  signalMaxPrice: number | null;
  signalMaxPriceGain: number | null;
  signalTokenLevel: string | null;
  heatmapToSignalLagSec: number | null;
  heatmapSeenBeforeSignal: boolean;
};

/**
 * Fully normalized token signal. It contains raw metrics plus two separate
 * scores: activityScore and pumpPrecursorScore.
 */
export type DeBotTrendingSignal = DeBotHeatmapContext & {
  address: string;
  symbol: string | null;
  name: string | null;
  chain: string | null;
  pair: string | null;
  dex: string | null;
  baseToken: string | null;

  rank1m: number | null;
  rank5m: number | null;
  presence: "both" | "1m-only" | "5m-only";
  rankDelta5mMinus1m: number | null;

  activityScore1m: number | null;
  activityScore5m: number | null;
  activityScoreDelta1mMinus5m: number | null;
  activityIntensityRatio: number | null;

  price: number | null;
  priceChange1m: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  maxPriceGain: number | null;

  buys1m: number | null;
  sells1m: number | null;
  swaps1m: number | null;
  buyVolume1m: number | null;
  sellVolume1m: number | null;
  volume1m: number | null;
  uniqueWalletSwaps1m: number | null;
  buyPressure1m: number | null;

  buys5m: number | null;
  sells5m: number | null;
  swaps5m: number | null;
  buyVolume5m: number | null;
  sellVolume5m: number | null;
  volume5m: number | null;
  uniqueWalletSwaps5m: number | null;
  buyPressure5m: number | null;

  buyPressureDelta1mMinus5m: number | null;
  volumeAcceleration: number | null;
  walletAcceleration: number | null;

  liquidity: number | null;
  holders: number | null;
  marketCap: number | null;
  fdv: number | null;

  smartWalletOnlineCount1m: number | null;
  smartWalletTotalCount1m: number | null;
  smartWalletCoverage1m: number | null;
  smartWalletOnlineCount5m: number | null;
  smartWalletTotalCount5m: number | null;
  smartWalletCoverage5m: number | null;

  tokenTier: string | null;
  launchpad: string | null;
  tags: string[];
  fromLaunchpad: boolean | null;
  safeMintAbandoned: number | null;
  safeBlockAddress: number | null;
  creatorAddress: string | null;
  creationTimestamp: number | null;
  lastUpdateTime1m: number | null;
  lastUpdateTime5m: number | null;

  // Separate research scores.
  activityScore: number | null;
  activityEvidenceCount: number;
  activityWeight: number;
  activityRank1mComponent: number | null;
  activityRank5mComponent: number | null;
  activityIntensityComponent: number | null;

  pumpPrecursorScore: number | null;
  pumpPrecursorEvidenceCount: number;
  pumpPrecursorPositiveEvidenceCount: number;
  pumpPrecursorWeight: number;
  pumpBuyPressureComponent: number | null;
  pumpBuyPressureDeltaComponent: number | null;
  pumpVolumeComponent: number | null;
  pumpWalletComponent: number | null;

  isTrending: boolean;
  isPumpPrecursorCandidate: boolean;
  candidateReason: string | null;
};

export type DeBotTrendingSnapshot = {
  fetchedAt: string;
  observedAtSec: number;
  oneMinute: DeBotActivityRankResponse;
  fiveMinute: DeBotActivityRankResponse;
  heatmap: DeBotHeatmapResponse;
  signals: DeBotTrendingSignal[];
};

export type DeBotRankOptions = { duration: DeBotDuration; limit?: number };
export type DeBotTrendingOptions = { limit?: number };
export type DeBotWatchOptions = { intervalMs?: number; iterations?: number; limit?: number };

/**
 * Explain why signals do or do not pass the configured pump-precursor gates.
 * This is diagnostic only; it does not alter candidate selection.
 */
export type DeBotPumpCandidateDiagnostics = {
  totalSignals: number;
  require1mPassed: number;
  presencePassed: number;
  scored: number;
  evidencePassed: number;
  volumePassed: number;
  positiveEvidencePassed: number;
  heatmapPassed: number;
  finalCandidates: number;
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function market(item: DeBotActivityRankItem | null): DeBotMarketInfo {
  return item?.market_info ?? {};
}

function buyPressure(item: DeBotActivityRankItem | null): number | null {
  const buy = numberOrNull(market(item).buy_volume);
  const sell = numberOrNull(market(item).sell_volume);
  if (buy === null || sell === null || buy < 0 || sell < 0) return null;
  const total = buy + sell;
  return total > 0 ? buy / total : null;
}

function smartCoverage(item: DeBotActivityRankItem | null): number | null {
  const online = numberOrNull(item?.smart_wallet_online_count);
  const total = numberOrNull(item?.smart_wallet_total_count);
  if (online === null || total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, online / total));
}

/**
 * Convert cumulative short/long windows into a per-minute pace ratio.
 * A result of 1.0 means the short window is running at the same pace.
 */
function paceRatio(shortValue: number | null, longValue: number | null): number | null {
  if (shortValue === null || longValue === null || shortValue < 0 || longValue <= 0) return null;
  return shortValue / (longValue / 5);
}

function intensityRatio(shortValue: number | null, longValue: number | null): number | null {
  if (shortValue === null || longValue === null || shortValue < 0 || longValue <= 0) return null;
  return shortValue / longValue;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rankMap(items: DeBotActivityRankItem[]): Map<string, { rank: number; item: DeBotActivityRankItem }> {
  return new Map(
    items
      .filter((item) => typeof item.address === "string" && item.address.length > 0)
      .map((item, index) => [item.address, { rank: index + 1, item }]),
  );
}

function inverseRankScore(rank: number | null, limit: number): number | null {
  if (rank === null || limit <= 0) return null;
  return clamp01((limit - rank + 1) / limit);
}

/**
 * Use a logarithmic scale for acceleration. This prevents a single extreme
 * ratio from dominating all other observations.
 */
function accelerationScore(value: number | null, saturation: number): number | null {
  if (value === null || saturation <= 1) return null;
  if (value <= 1) return 0;
  return clamp01(Math.log(value) / Math.log(saturation));
}

function intensityScore(value: number | null, saturation: number): number | null {
  if (value === null || saturation <= 0) return null;
  return clamp01(value / saturation);
}

function positiveDeltaScore(delta: number | null, saturation: number): number | null {
  if (delta === null || saturation <= 0) return null;
  return clamp01(Math.max(0, delta) / saturation);
}

function buyPressureScore(value: number | null): number | null {
  if (value === null) return null;
  return clamp01((value - 0.5) / 0.5);
}

function recentHeatmapScore(recencySec: number | null, maxRecencySec: number): number | null {
  if (recencySec === null || maxRecencySec <= 0 || recencySec < 0 || recencySec > maxRecencySec) return null;
  return clamp01(1 - recencySec / maxRecencySec);
}

function buildHeatmapIndex(heatmap: DeBotHeatmapBucket[], observedAtSec: number): Map<string, DeBotHeatmapContext> {
  const result = new Map<string, DeBotHeatmapContext>();
  const buckets = [...heatmap]
    .filter((bucket) => Number.isFinite(bucket.time) && bucket.time <= observedAtSec)
    .sort((a, b) => a.time - b.time);

  for (const bucket of buckets) {
    const tokens = new Set(
      (Array.isArray(bucket.tokens) ? bucket.tokens : [])
        .filter((token): token is string => typeof token === "string" && token.length > 0),
    );

    for (const token of tokens) {
      const currentWalletCount = numberOrNull(bucket.wallet_count);
      const currentTradeVolume = numberOrNull(bucket.trade_volume);
      const existing = result.get(token);

      if (!existing) {
        result.set(token, {
          heatmapSeen: true,
          heatmapOccurrenceCount: 1,
          heatmapFirstSeenSec: bucket.time,
          heatmapLastSeenSec: bucket.time,
          heatmapRecencySec: Math.max(0, observedAtSec - bucket.time),
          latestMarketWalletCount: currentWalletCount,
          latestMarketTradeVolume: currentTradeVolume,
          previousMarketWalletCount: null,
          previousMarketTradeVolume: null,
          marketWalletAcceleration: null,
          marketVolumeAcceleration: null,
          signalCount: null,
          signalFirstTimeSec: null,
          signalFirstPrice: null,
          signalMaxPrice: null,
          signalMaxPriceGain: null,
          signalTokenLevel: null,
          heatmapToSignalLagSec: null,
          heatmapSeenBeforeSignal: false,
        });
        continue;
      }

      existing.previousMarketWalletCount = existing.latestMarketWalletCount;
      existing.previousMarketTradeVolume = existing.latestMarketTradeVolume;
      existing.latestMarketWalletCount = currentWalletCount;
      existing.latestMarketTradeVolume = currentTradeVolume;
      existing.marketWalletAcceleration = paceRatio(currentWalletCount, existing.previousMarketWalletCount);
      existing.marketVolumeAcceleration = paceRatio(currentTradeVolume, existing.previousMarketTradeVolume);
      existing.heatmapOccurrenceCount += 1;
      existing.heatmapLastSeenSec = bucket.time;
      existing.heatmapRecencySec = Math.max(0, observedAtSec - bucket.time);
    }
  }

  return result;
}

function attachHeatmapMeta(
  context: DeBotHeatmapContext,
  metaSignal: DeBotHeatmapMetaSignal | undefined,
): DeBotHeatmapContext {
  if (!metaSignal) return context;
  const firstTime = numberOrNull(metaSignal.first_time);
  const firstHeatmap = context.heatmapFirstSeenSec;
  const lag = firstTime !== null && firstHeatmap !== null ? firstTime - firstHeatmap : null;
  return {
    ...context,
    signalCount: numberOrNull(metaSignal.signal_count),
    signalFirstTimeSec: firstTime,
    signalFirstPrice: numberOrNull(metaSignal.first_price),
    signalMaxPrice: numberOrNull(metaSignal.max_price),
    signalMaxPriceGain: numberOrNull(metaSignal.max_price_gain),
    signalTokenLevel: stringOrNull(metaSignal.token_level),
    heatmapToSignalLagSec: lag,
    heatmapSeenBeforeSignal: firstHeatmap !== null && firstTime !== null ? firstHeatmap <= firstTime : false,
  };
}

function noHeatmapContext(): DeBotHeatmapContext {
  return {
    heatmapSeen: false,
    heatmapOccurrenceCount: 0,
    heatmapFirstSeenSec: null,
    heatmapLastSeenSec: null,
    heatmapRecencySec: null,
    latestMarketWalletCount: null,
    latestMarketTradeVolume: null,
    previousMarketWalletCount: null,
    previousMarketTradeVolume: null,
    marketWalletAcceleration: null,
    marketVolumeAcceleration: null,
    signalCount: null,
    signalFirstTimeSec: null,
    signalFirstPrice: null,
    signalMaxPrice: null,
    signalMaxPriceGain: null,
    signalTokenLevel: null,
    heatmapToSignalLagSec: null,
    heatmapSeenBeforeSignal: false,
  };
}

type ActivityScoreResult = {
  score: number | null;
  evidenceCount: number;
  weight: number;
  rank1m: number | null;
  rank5m: number | null;
  intensity: number | null;
};

type PumpScoreResult = {
  score: number | null;
  evidenceCount: number;
  positiveEvidenceCount: number;
  weight: number;
  buyPressure: number | null;
  buyPressureDelta: number | null;
  volume: number | null;
  wallet: number | null;
};

function normalizedWeightedScore(
  components: Array<{ value: number | null; weight: number }>,
): { score: number | null; weight: number; evidenceCount: number } {
  let numerator = 0;
  let denominator = 0;
  let evidenceCount = 0;

  for (const component of components) {
    if (component.value === null || component.weight <= 0) continue;
    numerator += component.value * component.weight;
    denominator += component.weight;
    evidenceCount += 1;
  }

  return {
    score: denominator > 0 ? (numerator / denominator) * 100 : null,
    weight: denominator,
    evidenceCount,
  };
}

function buildActivityScore(signal: {
  rank1m: number | null;
  rank5m: number | null;
  activity1m: number | null;
}, config: Pick<DeBotClientConfig, "rankLimit" | "scoreWeights" | "activityScoreSaturation">): ActivityScoreResult {
  const rank1m = inverseRankScore(signal.rank1m, config.rankLimit);
  const rank5m = inverseRankScore(signal.rank5m, config.rankLimit);
  const intensity = intensityScore(signal.activity1m, config.activityScoreSaturation);
  const result = normalizedWeightedScore([
    { value: rank1m, weight: config.scoreWeights.activityRank1m },
    { value: rank5m, weight: config.scoreWeights.activityRank5m },
    { value: intensity, weight: config.scoreWeights.activityIntensity },
  ]);

  return { ...result, rank1m, rank5m, intensity };
}

function buildPumpScore(signal: {
  buyPressure1m: number | null;
  buyPressureDelta: number | null;
  volumeAcceleration: number | null;
  walletAcceleration: number | null;
}, config: Pick<DeBotClientConfig, "scoreWeights" | "accelerationSaturation" | "buyPressureDeltaSaturation">): PumpScoreResult {
  const buyPressure = buyPressureScore(signal.buyPressure1m);
  const buyPressureDelta = positiveDeltaScore(signal.buyPressureDelta, config.buyPressureDeltaSaturation);
  const volume = accelerationScore(signal.volumeAcceleration, config.accelerationSaturation);
  const wallet = accelerationScore(signal.walletAcceleration, config.accelerationSaturation);
  const components = [
    { value: buyPressure, weight: config.scoreWeights.buyPressure1m },
    { value: buyPressureDelta, weight: config.scoreWeights.buyPressureDelta },
    { value: volume, weight: config.scoreWeights.volumeAcceleration },
    { value: wallet, weight: config.scoreWeights.walletAcceleration },
  ];
  const result = normalizedWeightedScore(components);
  const positiveEvidenceCount = components.filter((component) => component.value !== null && component.value > 0).length;

  return { ...result, positiveEvidenceCount, buyPressure, buyPressureDelta, volume, wallet };
}

function buildSignal(
  address: string,
  oneMinute: { rank: number; item: DeBotActivityRankItem } | undefined,
  fiveMinute: { rank: number; item: DeBotActivityRankItem } | undefined,
  heatmapContext: DeBotHeatmapContext,
  metaSignal: DeBotHeatmapMetaSignal | undefined,
  config: DeBotClientConfig,
): DeBotTrendingSignal {
  const item1m = oneMinute?.item ?? null;
  const item5m = fiveMinute?.item ?? null;
  const primary = item1m ?? item5m;
  const primaryMarket = market(primary);
  const market1m = market(item1m);
  const market5m = market(item5m);

  const activity1m = numberOrNull(item1m?.activity_score);
  const activity5m = numberOrNull(item5m?.activity_score);
  const buys1m = numberOrNull(market1m.buys);
  const sells1m = numberOrNull(market1m.sells);
  const swaps1m = numberOrNull(market1m.swaps);
  const buyVolume1m = numberOrNull(market1m.buy_volume);
  const sellVolume1m = numberOrNull(market1m.sell_volume);
  const volume1m = numberOrNull(market1m.volume);
  const uniqueWalletSwaps1m = numberOrNull(market1m.uniq_wallet_swaps);
  const buys5m = numberOrNull(market5m.buys);
  const sells5m = numberOrNull(market5m.sells);
  const swaps5m = numberOrNull(market5m.swaps);
  const buyVolume5m = numberOrNull(market5m.buy_volume);
  const sellVolume5m = numberOrNull(market5m.sell_volume);
  const volume5m = numberOrNull(market5m.volume);
  const uniqueWalletSwaps5m = numberOrNull(market5m.uniq_wallet_swaps);

  const buyPressure1m = buyPressure(item1m);
  const buyPressure5m = buyPressure(item5m);
  const buyPressureDelta = buyPressure1m !== null && buyPressure5m !== null
    ? buyPressure1m - buyPressure5m
    : null;
  const volumeAcceleration = paceRatio(volume1m, volume5m);
  const walletAcceleration = paceRatio(uniqueWalletSwaps1m, uniqueWalletSwaps5m);
  const attachedHeatmap = attachHeatmapMeta(heatmapContext, metaSignal);

  const activity = buildActivityScore(
    { rank1m: oneMinute?.rank ?? null, rank5m: fiveMinute?.rank ?? null, activity1m },
    config,
  );
  const pump = buildPumpScore(
    { buyPressure1m, buyPressureDelta, volumeAcceleration, walletAcceleration },
    config,
  );

  const heatmapRecent = attachedHeatmap.heatmapRecencySec !== null
    ? attachedHeatmap.heatmapRecencySec <= config.maxHeatmapRecencySec
    : false;
  const heatmapScore = recentHeatmapScore(attachedHeatmap.heatmapRecencySec, config.maxHeatmapRecencySec);

  // Heatmap is intentionally excluded from pumpPrecursorScore. It is market
  // context and should not silently become a token-level directional signal.
  const isTrending = activity.score !== null && activity.score >= config.minActivityScore;
  const isPumpPrecursorCandidate =
    pump.score !== null &&
    pump.score >= config.minPumpPrecursorScore &&
    pump.evidenceCount >= config.minPumpPrecursorEvidence &&
    pump.volume !== null && pump.volume > config.minVolumeAcceleration &&
    pump.positiveEvidenceCount >= config.minPumpPrecursorPositiveEvidence &&
    (!config.requireHeatmap || (attachedHeatmap.heatmapSeen && heatmapRecent));

  const candidateReasons: string[] = [];
  if (isPumpPrecursorCandidate) candidateReasons.push("pump-precursor");
  if (isTrending) candidateReasons.push("high-current-activity");
  if (pump.buyPressure !== null && pump.buyPressure > 0.5) candidateReasons.push(`buy-pressure ${(pump.buyPressure * 100).toFixed(1)}%`);
  if (pump.buyPressureDelta !== null && pump.buyPressureDelta > 0) candidateReasons.push(`buy-delta +${(pump.buyPressureDelta * 100).toFixed(1)}pp`);
  if (pump.volume !== null && pump.volume > 1) candidateReasons.push(`volume ${pump.volume.toFixed(2)}x`);
  if (pump.volume !== null && pump.volume <= config.minVolumeAcceleration) candidateReasons.push(`volume-gate ${pump.volume.toFixed(2)}x`);
  if (pump.wallet !== null && pump.wallet > 1) candidateReasons.push(`wallets ${pump.wallet.toFixed(2)}x`);
  if (attachedHeatmap.heatmapSeen) candidateReasons.push(heatmapRecent ? "heatmap-recent" : "heatmap-stale");
  if (heatmapScore !== null && heatmapScore === 0) candidateReasons.push("heatmap-outside-recent-window");

  return {
    ...attachedHeatmap,
    address,
    symbol: stringOrNull(primary?.symbol),
    name: stringOrNull(primary?.name),
    chain: stringOrNull(primary?.chain),
    pair: stringOrNull(primary?.pair),
    dex: stringOrNull(primary?.dex?.dex_name),
    baseToken: stringOrNull(primary?.base_token?.address),
    rank1m: oneMinute?.rank ?? null,
    rank5m: fiveMinute?.rank ?? null,
    presence: oneMinute && fiveMinute ? "both" : oneMinute ? "1m-only" : "5m-only",
    rankDelta5mMinus1m: oneMinute && fiveMinute ? fiveMinute.rank - oneMinute.rank : null,
    activityScore1m: activity1m,
    activityScore5m: activity5m,
    activityScoreDelta1mMinus5m: activity1m !== null && activity5m !== null ? activity1m - activity5m : null,
    activityIntensityRatio: intensityRatio(activity1m, activity5m),
    price: numberOrNull(primaryMarket.price),
    priceChange1m: numberOrNull(market1m.percent),
    priceChange5m: numberOrNull(market5m.percent),
    priceChange1h: numberOrNull(primaryMarket.percent_1h),
    priceChange24h: numberOrNull(primaryMarket.percent_24h),
    maxPriceGain: numberOrNull(primary?.max_price_gain),
    buys1m,
    sells1m,
    swaps1m,
    buyVolume1m,
    sellVolume1m,
    volume1m,
    uniqueWalletSwaps1m,
    buyPressure1m,
    buys5m,
    sells5m,
    swaps5m,
    buyVolume5m,
    sellVolume5m,
    volume5m,
    uniqueWalletSwaps5m,
    buyPressure5m,
    buyPressureDelta1mMinus5m: buyPressureDelta,
    volumeAcceleration,
    walletAcceleration,
    liquidity: numberOrNull(primary?.pair_summary_info?.liquidity),
    holders: numberOrNull(primaryMarket.holders),
    marketCap: numberOrNull(primaryMarket.mkt_cap),
    fdv: numberOrNull(primaryMarket.fdv),
    smartWalletOnlineCount1m: numberOrNull(item1m?.smart_wallet_online_count),
    smartWalletTotalCount1m: numberOrNull(item1m?.smart_wallet_total_count),
    smartWalletCoverage1m: smartCoverage(item1m),
    smartWalletOnlineCount5m: numberOrNull(item5m?.smart_wallet_online_count),
    smartWalletTotalCount5m: numberOrNull(item5m?.smart_wallet_total_count),
    smartWalletCoverage5m: smartCoverage(item5m),
    tokenTier: stringOrNull(primary?.token_tier),
    launchpad: stringOrNull(primary?.launchpad),
    tags: primary?.tags?.filter((tag): tag is string => typeof tag === "string") ?? [],
    fromLaunchpad: typeof primary?.from_launchpad === "boolean" ? primary.from_launchpad : null,
    safeMintAbandoned: numberOrNull(primary?.safe_info?.solana?.is_mint_abandoned),
    safeBlockAddress: numberOrNull(primary?.safe_info?.solana?.is_block_address),
    creatorAddress: stringOrNull(primary?.creator_address),
    creationTimestamp: numberOrNull(primary?.creation_timestamp),
    lastUpdateTime1m: numberOrNull(market1m.last_update_time),
    lastUpdateTime5m: numberOrNull(market5m.last_update_time),
    activityScore: activity.score,
    activityEvidenceCount: activity.evidenceCount,
    activityWeight: activity.weight,
    activityRank1mComponent: activity.rank1m,
    activityRank5mComponent: activity.rank5m,
    activityIntensityComponent: activity.intensity,
    pumpPrecursorScore: pump.score,
    pumpPrecursorEvidenceCount: pump.evidenceCount,
    pumpPrecursorPositiveEvidenceCount: pump.positiveEvidenceCount,
    pumpPrecursorWeight: pump.weight,
    pumpBuyPressureComponent: pump.buyPressure,
    pumpBuyPressureDeltaComponent: pump.buyPressureDelta,
    pumpVolumeComponent: pump.volume,
    pumpWalletComponent: pump.wallet,
    isTrending,
    isPumpPrecursorCandidate,
    candidateReason: candidateReasons.length > 0 ? candidateReasons.join("; ") : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Typed client for DeBot community-signal endpoints. */
export class DeBotClient {
  private readonly config: DeBotClientConfig;
  private readonly baseUrl: string;

  constructor(config: DeBotClientConfig) {
    if (!config.baseUrl.trim()) throw new Error("baseUrl must not be empty");
    if (!config.chain.trim()) throw new Error("chain must not be empty");
    if (!Number.isInteger(config.rankLimit) || config.rankLimit <= 0) throw new Error("rankLimit must be > 0");
    if (!Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0) throw new Error("requestTimeoutMs must be > 0");
    if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs <= 0) throw new Error("pollIntervalMs must be > 0");
    if (!Number.isInteger(config.candidateLimit) || config.candidateLimit <= 0) throw new Error("candidateLimit must be > 0");
    if (!Number.isFinite(config.minPumpPrecursorScore) || config.minPumpPrecursorScore < 0 || config.minPumpPrecursorScore > 100) throw new Error("minPumpPrecursorScore must be 0..100");
    if (!Number.isInteger(config.minPumpPrecursorEvidence) || config.minPumpPrecursorEvidence <= 0) throw new Error("minPumpPrecursorEvidence must be > 0");
    if (!Number.isInteger(config.minPumpPrecursorPositiveEvidence) || config.minPumpPrecursorPositiveEvidence < 0) throw new Error("minPumpPrecursorPositiveEvidence must be >= 0");
    if (!Number.isFinite(config.minActivityScore) || config.minActivityScore < 0 || config.minActivityScore > 100) throw new Error("minActivityScore must be 0..100");
    if (!Number.isInteger(config.minActivityEvidence) || config.minActivityEvidence <= 0) throw new Error("minActivityEvidence must be > 0");
    if (!Object.values(config.scoreWeights).every((value) => Number.isFinite(value) && value >= 0)) throw new Error("score weights must be non-negative finite numbers");
    if (config.scoreWeights.activityRank1m + config.scoreWeights.activityRank5m + config.scoreWeights.activityIntensity <= 0) throw new Error("activity score weights must contain a positive weight");
    if (config.scoreWeights.buyPressure1m + config.scoreWeights.buyPressureDelta + config.scoreWeights.volumeAcceleration + config.scoreWeights.walletAcceleration <= 0) throw new Error("pump score weights must contain a positive weight");
    if (!Number.isFinite(config.accelerationSaturation) || config.accelerationSaturation <= 1) throw new Error("accelerationSaturation must be > 1");
    if (!Number.isFinite(config.activityScoreSaturation) || config.activityScoreSaturation <= 0) throw new Error("activityScoreSaturation must be > 0");
    if (!Number.isFinite(config.buyPressureDeltaSaturation) || config.buyPressureDeltaSaturation <= 0) throw new Error("buyPressureDeltaSaturation must be > 0");
    if (!Number.isInteger(config.maxHeatmapRecencySec) || config.maxHeatmapRecencySec < 0) throw new Error("maxHeatmapRecencySec must be >= 0");
    if (!Number.isInteger(config.retryAttempts) || config.retryAttempts < 0) throw new Error("retryAttempts must be >= 0");
    if (!Number.isInteger(config.retryBackoffMs) || config.retryBackoffMs <= 0) throw new Error("retryBackoffMs must be > 0");
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  /** Fetch the current 1m or 5m activity ranking. */
  async fetchActivityRank(options: DeBotRankOptions): Promise<DeBotActivityRankResponse> {
    const limit = options.limit ?? this.config.rankLimit;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be > 0");
    const url = new URL(`${this.baseUrl}/community/signal/channel/activity/rank`);
    url.searchParams.set("chain", this.config.chain);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("duration", options.duration);
    const payload = await this.getJson<DeBotResponse<DeBotActivityRankItem[]>>(url);
    this.assertSuccess(payload, "activity rank");
    if (!Array.isArray(payload.data)) throw new Error("DeBot activity rank data is not an array");
    return payload;
  }

  /** Fetch the 10-minute channel heatmap/context endpoint. */
  async fetchChannelHeatmap(): Promise<DeBotHeatmapResponse> {
    const url = new URL(`${this.baseUrl}/community/signal/channel/heatmap`);
    url.searchParams.set("chain", this.config.chain);
    const payload = await this.getJson<DeBotResponse<DeBotHeatmapData>>(url);
    this.assertSuccess(payload, "heatmap");
    if (!payload.data || !payload.data.meta || !payload.data.meta.signals || !Array.isArray(payload.data.heatmap)) {
      throw new Error("DeBot heatmap response does not match the expected schema");
    }
    return payload;
  }

  /**
   * Fetch all three DeBot datasets concurrently and normalize them by token.
   */
  async fetchTrendingSignals(options: DeBotTrendingOptions = {}): Promise<DeBotTrendingSnapshot> {
    const limit = options.limit ?? this.config.rankLimit;
    const fetchedAt = new Date().toISOString();
    const observedAtSec = Math.floor(Date.now() / 1000);

    const [oneMinute, fiveMinute, heatmap] = await Promise.all([
      this.fetchActivityRank({ duration: "1m", limit }),
      this.fetchActivityRank({ duration: "5m", limit }),
      this.fetchChannelHeatmap(),
    ]);

    const oneMinuteMap = rankMap(oneMinute.data);
    const fiveMinuteMap = rankMap(fiveMinute.data);
    const heatmapIndex = buildHeatmapIndex(heatmap.data.heatmap, observedAtSec);
    const signalMeta = heatmap.data.meta.signals;
    const addresses = new Set([
      ...oneMinuteMap.keys(),
      ...fiveMinuteMap.keys(),
      ...Object.keys(signalMeta),
    ]);

    const signals = [...addresses]
      .map((address) => buildSignal(
        address,
        oneMinuteMap.get(address),
        fiveMinuteMap.get(address),
        heatmapIndex.get(address) ?? noHeatmapContext(),
        signalMeta[address],
        this.config,
      ))
      .sort((a, b) => {
        const pumpA = a.pumpPrecursorScore ?? -Infinity;
        const pumpB = b.pumpPrecursorScore ?? -Infinity;
        if (pumpA !== pumpB) return pumpB - pumpA;
        const activityA = a.activityScore ?? -Infinity;
        const activityB = b.activityScore ?? -Infinity;
        if (activityA !== activityB) return activityB - activityA;
        return a.address.localeCompare(b.address);
      });

    return { fetchedAt, observedAtSec, oneMinute, fiveMinute, heatmap, signals };
  }

  /** Return current-activity leaders, independent of pump-precursor evidence. */
  getActivityLeaders(snapshot: DeBotTrendingSnapshot, limit = this.config.candidateLimit): DeBotTrendingSignal[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("activity leader limit must be > 0");
    return snapshot.signals
      .filter((signal) => signal.activityScore !== null && signal.activityScore >= this.config.minActivityScore && signal.activityEvidenceCount >= this.config.minActivityEvidence)
      .sort((a, b) => (b.activityScore ?? -Infinity) - (a.activityScore ?? -Infinity))
      .slice(0, limit);
  }

  /**
   * Return tokens suitable for the later Helius pump-wallet analysis.
   * Ranking is based on pump-precursor evidence, not current activity alone.
   */
  /**
   * Return stage-by-stage candidate counts so zero-candidate runs are easy to diagnose.
   */
  getPumpCandidateDiagnostics(snapshot: DeBotTrendingSnapshot): DeBotPumpCandidateDiagnostics {
    let require1mPassed = 0;
    let presencePassed = 0;
    let scored = 0;
    let evidencePassed = 0;
    let volumePassed = 0;
    let positiveEvidencePassed = 0;
    let heatmapPassed = 0;
    let finalCandidates = 0;

    for (const signal of snapshot.signals) {
      if (this.config.require1m && signal.rank1m === null) continue;
      require1mPassed += 1;

      if (!this.config.include1mOnly && signal.presence !== "both") continue;
      presencePassed += 1;

      if (signal.pumpPrecursorScore === null) continue;
      scored += 1;

      if (signal.pumpPrecursorEvidenceCount < this.config.minPumpPrecursorEvidence) continue;
      evidencePassed += 1;

      if (signal.volumeAcceleration === null || signal.volumeAcceleration <= this.config.minVolumeAcceleration) continue;
      volumePassed += 1;

      if (signal.pumpPrecursorPositiveEvidenceCount < this.config.minPumpPrecursorPositiveEvidence) continue;
      positiveEvidencePassed += 1;

      const heatmapRecent =
        signal.heatmapRecencySec !== null &&
        signal.heatmapRecencySec <= this.config.maxHeatmapRecencySec;
      if (this.config.requireHeatmap && !(signal.heatmapSeen && heatmapRecent)) continue;
      heatmapPassed += 1;

      if (signal.pumpPrecursorScore >= this.config.minPumpPrecursorScore) finalCandidates += 1;
    }

    return {
      totalSignals: snapshot.signals.length,
      require1mPassed,
      presencePassed,
      scored,
      evidencePassed,
      volumePassed,
      positiveEvidencePassed,
      heatmapPassed,
      finalCandidates,
    };
  }

  getPumpPrecursorCandidates(snapshot: DeBotTrendingSnapshot, limit = this.config.candidateLimit): DeBotTrendingSignal[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("candidate limit must be > 0");
    return snapshot.signals
      .filter((signal) => {
        if (this.config.require1m && signal.rank1m === null) return false;
        if (!this.config.include1mOnly && signal.presence !== "both") return false;
        return signal.isPumpPrecursorCandidate;
      })
      .sort((a, b) => {
        const scoreA = a.pumpPrecursorScore ?? -Infinity;
        const scoreB = b.pumpPrecursorScore ?? -Infinity;
        if (scoreA !== scoreB) return scoreB - scoreA;
        if (a.pumpPrecursorPositiveEvidenceCount !== b.pumpPrecursorPositiveEvidenceCount) {
          return b.pumpPrecursorPositiveEvidenceCount - a.pumpPrecursorPositiveEvidenceCount;
        }
        return (b.activityScore ?? -Infinity) - (a.activityScore ?? -Infinity);
      })
      .slice(0, limit);
  }

  /** Annotate all rows so the two-log output is self-contained. */
  annotateCandidates(snapshot: DeBotTrendingSnapshot): DeBotTrendingSnapshot {
    const activity = new Set(this.getActivityLeaders(snapshot).map((signal) => signal.address));
    const pump = new Set(this.getPumpPrecursorCandidates(snapshot).map((signal) => signal.address));
    return {
      ...snapshot,
      signals: snapshot.signals.map((signal) => ({
        ...signal,
        isTrending: activity.has(signal.address),
        isPumpPrecursorCandidate: pump.has(signal.address),
      })),
    };
  }

  /** Poll complete snapshots for future real-time DeBot → Helius integration. */
  async *watchTrendingSignals(options: DeBotWatchOptions = {}): AsyncGenerator<DeBotTrendingSnapshot> {
    const intervalMs = options.intervalMs ?? this.config.pollIntervalMs;
    const iterations = options.iterations;
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new Error("watch interval must be > 0");
    if (iterations !== undefined && (!Number.isInteger(iterations) || iterations <= 0)) throw new Error("iterations must be > 0");

    let count = 0;
    while (iterations === undefined || count < iterations) {
      yield await this.fetchTrendingSignals({ limit: options.limit });
      count += 1;
      if (iterations !== undefined && count >= iterations) return;
      await sleep(intervalMs);
    }
  }

  private assertSuccess<T extends { code: number; description?: string }>(payload: T, label: string): void {
    if (payload.code !== 0) throw new Error(`DeBot ${label} failed (${payload.code}): ${payload.description ?? "unknown error"}`);
  }

  private async getJson<T>(url: URL): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.config.retryAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

        const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
        const body = await response.text();

        if (!response.ok) {
          lastError = new Error(`DeBot HTTP ${response.status}: ${response.statusText}; body=${body.slice(0, 500)}`);
          if (!isRetryableStatus(response.status) || attempt >= this.config.retryAttempts) throw lastError;
          await sleep(this.config.retryBackoffMs * 2 ** attempt);
          continue;
        }

        try {
          return JSON.parse(body) as T;
        } catch (error) {
          throw new Error(`DeBot returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch (error) {
        lastError = error;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        const network = error instanceof TypeError;
        if ((aborted || network) && attempt < this.config.retryAttempts) {
          await sleep(this.config.retryBackoffMs * 2 ** attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = Bun.env[name]?.trim();
  return value || undefined;
}

function positiveIntEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeIntEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

function positiveNumberEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

function boundedPercentEnv(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${name} must be between 0 and 100`);
  return value;
}

function booleanEnv(name: string): boolean {
  const value = requiredEnv(name).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

/** Build a client from explicit .env configuration. */
export function loadDeBotClientFromEnv(): DeBotClient {
  return new DeBotClient({
    baseUrl: requiredEnv("DEBOT_BASE_URL"),
    chain: requiredEnv("DEBOT_CHAIN"),
    rankLimit: positiveIntEnv("DEBOT_RANK_LIMIT"),
    requestTimeoutMs: positiveIntEnv("DEBOT_REQUEST_TIMEOUT_MS"),
    apiKey: optionalEnv("DEBOT_API_KEY"),
    pollIntervalMs: positiveIntEnv("DEBOT_POLL_INTERVAL_MS"),
    candidateLimit: positiveIntEnv("DEBOT_CANDIDATE_LIMIT"),
    minPumpPrecursorScore: boundedPercentEnv("DEBOT_MIN_PUMP_PRECURSOR_SCORE"),
    minPumpPrecursorEvidence: positiveIntEnv("DEBOT_MIN_PUMP_PRECURSOR_EVIDENCE"),
    minPumpPrecursorPositiveEvidence: nonNegativeIntEnv("DEBOT_MIN_PUMP_PRECURSOR_POSITIVE_EVIDENCE"),
    minActivityScore: boundedPercentEnv("DEBOT_MIN_ACTIVITY_SCORE"),
    minActivityEvidence: positiveIntEnv("DEBOT_MIN_ACTIVITY_EVIDENCE"),
    minVolumeAcceleration: positiveNumberEnv("DEBOT_MIN_VOLUME_ACCELERATION"),
    require1m: booleanEnv("DEBOT_REQUIRE_1M"),
    include1mOnly: booleanEnv("DEBOT_INCLUDE_1M_ONLY"),
    accelerationSaturation: positiveNumberEnv("DEBOT_ACCELERATION_SATURATION"),
    activityScoreSaturation: positiveNumberEnv("DEBOT_ACTIVITY_SCORE_SATURATION"),
    buyPressureDeltaSaturation: positiveNumberEnv("DEBOT_BUY_PRESSURE_DELTA_SATURATION"),
    requireHeatmap: booleanEnv("DEBOT_REQUIRE_HEATMAP"),
    maxHeatmapRecencySec: nonNegativeIntEnv("DEBOT_MAX_HEATMAP_RECENCY_SEC"),
    retryAttempts: nonNegativeIntEnv("DEBOT_RETRY_ATTEMPTS"),
    retryBackoffMs: positiveIntEnv("DEBOT_RETRY_BACKOFF_MS"),
    scoreWeights: {
      activityRank1m: positiveNumberEnv("DEBOT_SCORE_WEIGHT_ACTIVITY_RANK_1M"),
      activityRank5m: positiveNumberEnv("DEBOT_SCORE_WEIGHT_ACTIVITY_RANK_5M"),
      activityIntensity: positiveNumberEnv("DEBOT_SCORE_WEIGHT_ACTIVITY_INTENSITY"),
      buyPressure1m: positiveNumberEnv("DEBOT_SCORE_WEIGHT_BUY_PRESSURE_1M"),
      buyPressureDelta: positiveNumberEnv("DEBOT_SCORE_WEIGHT_BUY_PRESSURE_DELTA"),
      volumeAcceleration: positiveNumberEnv("DEBOT_SCORE_WEIGHT_VOLUME_ACCELERATION"),
      walletAcceleration: positiveNumberEnv("DEBOT_SCORE_WEIGHT_WALLET_ACCELERATION"),
    },
  });
}
