import type { DeBotClientConfig } from './debot_client';

/** Runtime configuration loaded only from .env. No strategy defaults live in code. */
export type Config = {
  heliusApiKey: string;
  heliusRpcBaseUrl: string;
  heliusPageLimit: number;
  maxHistoryPages: number;
  heliusLightPageLimit: number;
  maxLightHistoryPages: number;
  maxLightSignatures: number;
  activityBucketSec: number;
  activeWindowSec: number;
  activeWindowCount: number;
  minActiveWindowTransactions: number;
  activeWindowContextSec: number;
  activeWindowMergeGapSec: number;
  fullWindowMergeGapSec: number;
  quietWindowSec: number;
  quietWindowCount: number;
  minQuietWindowTransactions: number;
  quietSearchStartSec: number;
  quietSearchEndSec: number;
  quietWindowContextSec: number;
  fineActivityBucketSec: number;
  maxFullTransactionsPerWindow: number;
  maxFullQueryWindows: number;
  heliusCacheEnabled: boolean;
  heliusCacheDir: string;
  heliusLightCacheTtlSec: number;
  heliusFullCacheTtlSec: number;
  heliusMinIntervalMs: number;
  retryAttempts: number;
  retryBackoffMs: number;
  rescanSkipSec: number;

  minMarketTradeSol: number;
  minLeaderTradeSol: number;
  bucketSec: number;

  pumpLookbackSec: number;
  pumpAccelReturn: number;
  pumpConfirmSec: number;
  pumpConfirmReturn: number;
  pumpMinBuySol: number;
  pumpBaselineSec: number;
  pumpMinVolumePace: number;
  pumpMinBuyPressure: number;
  pumpSustainedLookbackSec: number;
  pumpSustainedReturn: number;
  pumpSustainedConfirmSec: number;
  pumpSustainedConfirmReturn: number;
  pumpSustainedMinBuySol: number;
  pumpSustainedMinVolumePace: number;
  pumpSustainedMinBuyPressure: number;
  pumpClusterSec: number;
  pumpWindowSec: number;

  prePumpSec: number;
  earlyPumpSec: number;
  topWallets: number;
  leadFlowWindowSec: number;
  leaderResponseScale: number;
  leaderTimingDecaySec: number;
  forwardMaxExtraGapSec: number;

  forward1Sec: number;
  forward3Sec: number;
  forward5Sec: number;
  forward10Sec: number;
  forward15Sec: number;
  forward30Sec: number;
  forward60Sec: number;

  pumpPositiveRateThreshold: number;
  reliabilityPriorPumps: number;

  controlLookbackSec: number;
  controlGapSec: number;
  minControlTradeSol: number;
  minControlBuysPerPump: number;
  maxControlBuysPerPump: number;

  duckdbPath: string;
  duckdbThreads: number;
  tokenOutputRoot: string;
  globalExportDir: string;
  logDir: string;

  debotEnabled: boolean;
  debotScanCandidates: boolean;
  debot: DeBotClientConfig;
};

function env(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = Bun.env[name]?.trim();
  return value || undefined;
}

function num(name: string): number {
  const value = Number(env(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function positive(name: string): number {
  const value = num(name);
  if (value <= 0) throw new Error(`${name} must be > 0`);
  return value;
}

function positiveInt(name: string): number {
  const value = positive(name);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function nonNegative(name: string): number {
  const value = num(name);
  if (value < 0) throw new Error(`${name} must be >= 0`);
  return value;
}

function nonNegativeInt(name: string): number {
  const value = nonNegative(name);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function boundedPercent(name: string): number {
  const value = num(name);
  if (value < 0 || value > 100) throw new Error(`${name} must be between 0 and 100`);
  return value;
}

function booleanEnv(name: string): boolean {
  const value = env(name).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

/** Load and validate the complete application configuration from .env. */
export function loadConfig(): Config {
  const config: Config = {
    heliusApiKey: env('HELIUS_API_KEY'),
    heliusRpcBaseUrl: env('HELIUS_RPC_BASE_URL').replace(/\/$/, ''),
    heliusPageLimit: positiveInt('HELIUS_PAGE_LIMIT'),
    maxHistoryPages: positiveInt('MAX_HISTORY_PAGES'),
    heliusLightPageLimit: positiveInt('HELIUS_LIGHT_PAGE_LIMIT'),
    maxLightHistoryPages: positiveInt('MAX_LIGHT_HISTORY_PAGES'),
    maxLightSignatures: positiveInt('MAX_LIGHT_SIGNATURES'),
    activityBucketSec: positiveInt('ACTIVITY_BUCKET_SEC'),
    activeWindowSec: positiveInt('ACTIVE_WINDOW_SEC'),
    activeWindowCount: positiveInt('ACTIVE_WINDOW_COUNT'),
    minActiveWindowTransactions: positiveInt('MIN_ACTIVE_WINDOW_TRANSACTIONS'),
    activeWindowContextSec: nonNegativeInt('ACTIVE_WINDOW_CONTEXT_SEC'),
    activeWindowMergeGapSec: nonNegativeInt('ACTIVE_WINDOW_MERGE_GAP_SEC'),
    fullWindowMergeGapSec: nonNegativeInt('FULL_WINDOW_MERGE_GAP_SEC'),
    quietWindowSec: positiveInt('QUIET_WINDOW_SEC'),
    quietWindowCount: positiveInt('QUIET_WINDOW_COUNT'),
    minQuietWindowTransactions: nonNegativeInt('MIN_QUIET_WINDOW_TRANSACTIONS'),
    quietSearchStartSec: positiveInt('QUIET_SEARCH_START_SEC'),
    quietSearchEndSec: positiveInt('QUIET_SEARCH_END_SEC'),
    quietWindowContextSec: nonNegativeInt('QUIET_WINDOW_CONTEXT_SEC'),
    fineActivityBucketSec: positiveInt('FINE_ACTIVITY_BUCKET_SEC'),
    maxFullTransactionsPerWindow: positiveInt('MAX_FULL_TRANSACTIONS_PER_WINDOW'),
    maxFullQueryWindows: positiveInt('MAX_FULL_QUERY_WINDOWS'),
    heliusCacheEnabled: booleanEnv('HELIUS_CACHE_ENABLED'),
    heliusCacheDir: env('HELIUS_CACHE_DIR').replace(/\/$/, ''),
    heliusLightCacheTtlSec: nonNegativeInt('HELIUS_LIGHT_CACHE_TTL_SEC'),
    heliusFullCacheTtlSec: nonNegativeInt('HELIUS_FULL_CACHE_TTL_SEC'),
    heliusMinIntervalMs: nonNegativeInt('HELIUS_MIN_INTERVAL_MS'),
    retryAttempts: positiveInt('RETRY_ATTEMPTS'),
    retryBackoffMs: positiveInt('RETRY_BACKOFF_MS'),
    rescanSkipSec: nonNegativeInt('RESCAN_SKIP_SEC'),

    minMarketTradeSol: positive('MIN_MARKET_TRADE_SOL'),
    minLeaderTradeSol: positive('MIN_LEADER_TRADE_SOL'),
    bucketSec: positiveInt('BUCKET_SEC'),

    pumpLookbackSec: positiveInt('PUMP_LOOKBACK_SEC'),
    pumpAccelReturn: positive('PUMP_ACCEL_RETURN'),
    pumpConfirmSec: positiveInt('PUMP_CONFIRM_SEC'),
    pumpConfirmReturn: positive('PUMP_CONFIRM_RETURN'),
    pumpMinBuySol: positive('PUMP_MIN_BUY_SOL'),
    pumpBaselineSec: positiveInt('PUMP_BASELINE_SEC'),
    pumpMinVolumePace: positive('PUMP_MIN_VOLUME_PACE'),
    pumpMinBuyPressure: positive('PUMP_MIN_BUY_PRESSURE'),
    pumpSustainedLookbackSec: positiveInt('PUMP_SUSTAINED_LOOKBACK_SEC'),
    pumpSustainedReturn: positive('PUMP_SUSTAINED_RETURN'),
    pumpSustainedConfirmSec: positiveInt('PUMP_SUSTAINED_CONFIRM_SEC'),
    pumpSustainedConfirmReturn: positive('PUMP_SUSTAINED_CONFIRM_RETURN'),
    pumpSustainedMinBuySol: positive('PUMP_SUSTAINED_MIN_BUY_SOL'),
    pumpSustainedMinVolumePace: positive('PUMP_SUSTAINED_MIN_VOLUME_PACE'),
    pumpSustainedMinBuyPressure: positive('PUMP_SUSTAINED_MIN_BUY_PRESSURE'),
    pumpClusterSec: positiveInt('PUMP_CLUSTER_SEC'),
    pumpWindowSec: positiveInt('PUMP_WINDOW_SEC'),

    prePumpSec: nonNegativeInt('PRE_PUMP_SEC'),
    earlyPumpSec: nonNegativeInt('EARLY_PUMP_SEC'),
    topWallets: positiveInt('TOP_WALLETS'),
    leadFlowWindowSec: positiveInt('LEAD_FLOW_WINDOW_SEC'),
    leaderResponseScale: positive('LEADER_RESPONSE_SCALE'),
    leaderTimingDecaySec: positive('LEADER_TIMING_DECAY_SEC'),
    forwardMaxExtraGapSec: nonNegativeInt('FORWARD_MAX_EXTRA_GAP_SEC'),

    forward1Sec: positive('FORWARD_1S_SEC'),
    forward3Sec: positive('FORWARD_3S_SEC'),
    forward5Sec: positive('FORWARD_5S_SEC'),
    forward10Sec: positive('FORWARD_10S_SEC'),
    forward15Sec: positive('FORWARD_15S_SEC'),
    forward30Sec: positive('FORWARD_30S_SEC'),
    forward60Sec: positive('FORWARD_60S_SEC'),

    pumpPositiveRateThreshold: num('PUMP_POSITIVE_RATE_THRESHOLD'),
    reliabilityPriorPumps: positiveInt('RELIABILITY_PRIOR_PUMPS'),

    controlLookbackSec: positiveInt('CONTROL_LOOKBACK_SEC'),
    controlGapSec: nonNegativeInt('CONTROL_GAP_SEC'),
    minControlTradeSol: positive('MIN_CONTROL_TRADE_SOL'),
    minControlBuysPerPump: positiveInt('MIN_CONTROL_BUYS_PER_PUMP'),
    maxControlBuysPerPump: positiveInt('MAX_CONTROL_BUYS_PER_PUMP'),

    duckdbPath: env('DUCKDB_PATH'),
    duckdbThreads: positiveInt('DUCKDB_THREADS'),
    tokenOutputRoot: env('TOKEN_OUTPUT_ROOT').replace(/\/$/, ''),
    globalExportDir: env('GLOBAL_EXPORT_DIR').replace(/\/$/, ''),
    logDir: env('LOG_DIR').replace(/\/$/, ''),

    debotEnabled: booleanEnv('DEBOT_ENABLED'),
    debotScanCandidates: booleanEnv('DEBOT_SCAN_CANDIDATES'),
    debot: {
      baseUrl: env('DEBOT_BASE_URL'),
      chain: env('DEBOT_CHAIN'),
      rankLimit: positiveInt('DEBOT_RANK_LIMIT'),
      requestTimeoutMs: positiveInt('DEBOT_REQUEST_TIMEOUT_MS'),
      apiKey: optionalEnv('DEBOT_API_KEY'),
      pollIntervalMs: positiveInt('DEBOT_POLL_INTERVAL_MS'),
      candidateLimit: positiveInt('DEBOT_CANDIDATE_LIMIT'),
      minPumpPrecursorScore: boundedPercent('DEBOT_MIN_PUMP_PRECURSOR_SCORE'),
      minPumpPrecursorEvidence: positiveInt('DEBOT_MIN_PUMP_PRECURSOR_EVIDENCE'),
      minPumpPrecursorPositiveEvidence: nonNegativeInt('DEBOT_MIN_PUMP_PRECURSOR_POSITIVE_EVIDENCE'),
      minActivityScore: boundedPercent('DEBOT_MIN_ACTIVITY_SCORE'),
      minActivityEvidence: positiveInt('DEBOT_MIN_ACTIVITY_EVIDENCE'),
      minVolumeAcceleration: positive('DEBOT_MIN_VOLUME_ACCELERATION'),
      require1m: booleanEnv('DEBOT_REQUIRE_1M'),
      include1mOnly: booleanEnv('DEBOT_INCLUDE_1M_ONLY'),
      accelerationSaturation: positive('DEBOT_ACCELERATION_SATURATION'),
      activityScoreSaturation: positive('DEBOT_ACTIVITY_SCORE_SATURATION'),
      buyPressureDeltaSaturation: positive('DEBOT_BUY_PRESSURE_DELTA_SATURATION'),
      requireHeatmap: booleanEnv('DEBOT_REQUIRE_HEATMAP'),
      maxHeatmapRecencySec: nonNegativeInt('DEBOT_MAX_HEATMAP_RECENCY_SEC'),
      retryAttempts: nonNegativeInt('DEBOT_RETRY_ATTEMPTS'),
      retryBackoffMs: positiveInt('DEBOT_RETRY_BACKOFF_MS'),
      scoreWeights: {
        activityRank1m: positive('DEBOT_SCORE_WEIGHT_ACTIVITY_RANK_1M'),
        activityRank5m: positive('DEBOT_SCORE_WEIGHT_ACTIVITY_RANK_5M'),
        activityIntensity: positive('DEBOT_SCORE_WEIGHT_ACTIVITY_INTENSITY'),
        buyPressure1m: positive('DEBOT_SCORE_WEIGHT_BUY_PRESSURE_1M'),
        buyPressureDelta: positive('DEBOT_SCORE_WEIGHT_BUY_PRESSURE_DELTA'),
        volumeAcceleration: positive('DEBOT_SCORE_WEIGHT_VOLUME_ACCELERATION'),
        walletAcceleration: positive('DEBOT_SCORE_WEIGHT_WALLET_ACCELERATION'),
      },
    },
  };

  if (config.heliusPageLimit > 100) throw new Error('HELIUS_PAGE_LIMIT must be <= 100');
  if (config.heliusLightPageLimit > 1000) throw new Error('HELIUS_LIGHT_PAGE_LIMIT must be <= 1000');
  if (config.activityBucketSec >= config.activeWindowSec) throw new Error('ACTIVITY_BUCKET_SEC must be < ACTIVE_WINDOW_SEC');
  if (config.fineActivityBucketSec > config.activityBucketSec) throw new Error('FINE_ACTIVITY_BUCKET_SEC must be <= ACTIVITY_BUCKET_SEC');
  if (config.quietSearchEndSec <= config.quietSearchStartSec) throw new Error('QUIET_SEARCH_END_SEC must be > QUIET_SEARCH_START_SEC');
  if (config.quietWindowSec > config.quietSearchEndSec - config.quietSearchStartSec) throw new Error('QUIET_WINDOW_SEC must fit inside QUIET_SEARCH_START_SEC..QUIET_SEARCH_END_SEC');
  if (config.maxFullQueryWindows < config.activeWindowCount) throw new Error('MAX_FULL_QUERY_WINDOWS must be >= ACTIVE_WINDOW_COUNT');
  if (config.fullWindowMergeGapSec < 0) throw new Error('FULL_WINDOW_MERGE_GAP_SEC must be >= 0');
  if (config.pumpLookbackSec < config.bucketSec) throw new Error('PUMP_LOOKBACK_SEC must be >= BUCKET_SEC');
  if (config.pumpConfirmSec < config.bucketSec) throw new Error('PUMP_CONFIRM_SEC must be >= BUCKET_SEC');
  if (config.pumpClusterSec < config.bucketSec) throw new Error('PUMP_CLUSTER_SEC must be >= BUCKET_SEC');
  if (config.pumpBaselineSec <= config.pumpLookbackSec) throw new Error('PUMP_BASELINE_SEC must be > PUMP_LOOKBACK_SEC');
  if (config.pumpMinBuyPressure < 0 || config.pumpMinBuyPressure > 1) throw new Error('PUMP_MIN_BUY_PRESSURE must be between 0 and 1');
  if (config.pumpSustainedConfirmSec < config.pumpSustainedLookbackSec) throw new Error('PUMP_SUSTAINED_CONFIRM_SEC must be >= PUMP_SUSTAINED_LOOKBACK_SEC');
  if (config.pumpSustainedMinBuyPressure < 0 || config.pumpSustainedMinBuyPressure > 1) throw new Error('PUMP_SUSTAINED_MIN_BUY_PRESSURE must be between 0 and 1');
  if (config.pumpWindowSec < config.earlyPumpSec) throw new Error('PUMP_WINDOW_SEC must be >= EARLY_PUMP_SEC');
  if (config.maxControlBuysPerPump < config.minControlBuysPerPump) throw new Error('MAX_CONTROL_BUYS_PER_PUMP must be >= MIN_CONTROL_BUYS_PER_PUMP');
  if (config.controlLookbackSec <= config.prePumpSec + config.controlGapSec) throw new Error('CONTROL_LOOKBACK_SEC must be > PRE_PUMP_SEC + CONTROL_GAP_SEC');
  if (config.pumpPositiveRateThreshold <= 0 || config.pumpPositiveRateThreshold > 1) throw new Error('PUMP_POSITIVE_RATE_THRESHOLD must be in (0,1]');

  const horizons = [
    config.forward1Sec, config.forward3Sec, config.forward5Sec,
    config.forward10Sec, config.forward15Sec, config.forward30Sec, config.forward60Sec,
  ];
  for (let i = 1; i < horizons.length; i += 1) {
    if (horizons[i]! <= horizons[i - 1]!) throw new Error('FORWARD_*_SEC must be strictly increasing');
  }

  return config;
}
