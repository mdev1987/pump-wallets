import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Config } from './config';
import {
  parseTradesFromTransactionDetailed,
  type ActiveWindowSelection,
  type FetchResult,
  type ParseDropCounts,
  type RawTransaction,
  type Trade,
} from './analyzer';
import type { Logger } from './logger';

type SignatureRow = {
  signature?: string;
  slot?: number;
  blockTime?: number | null;
  err?: unknown;
};

type RpcResponse<T> = {
  error?: { code?: number; message?: string };
  result?: T;
};

type RpcResult<T> = {
  data?: T[];
  paginationToken?: string;
};

export type QuietWindowSelection = ActiveWindowSelection;

type TimeWindow = {
  startTimestamp: number;
  endTimestamp: number;
  estimatedTransactions: number;
};

type ActivityScan = {
  pages: number;
  transactionsReturned: number;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
  truncated: boolean;
  bucketCounts: Map<number, number>;
  fineBucketCounts: Map<number, number>;
  cacheHit: boolean;
};

type FullScanResult = {
  trades: Trade[];
  pages: number;
  transactionsReturned: number;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
  truncated: boolean;
  parseDropCounts: ParseDropCounts;
  fullCacheHits: number;
  fullCacheMisses: number;
};

/** Simple serial request limiter shared by lightweight and full Helius calls. */
class RequestLimiter {
  private nextAllowedAt = 0;

  constructor(private readonly minimumIntervalMs: number) {}

  async wait(): Promise<void> {
    const delay = this.nextAllowedAt - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.nextAllowedAt = Date.now() + this.minimumIntervalMs;
  }
}

/** Wait for a bounded amount of time. */
async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Return the start of a fixed-size timestamp bucket. */
function bucketStart(timestamp: number, bucketSizeSec: number): number {
  return Math.floor(timestamp / bucketSizeSec) * bucketSizeSec;
}

/** Merge numeric counter maps into one map. */
function addCount(map: Map<number, number>, key: number, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** Make one Helius request, honoring a serial rate limit and Retry-After. */
async function rpcRequest<T>(
  rpcUrl: string,
  body: Record<string, unknown>,
  config: Config,
  logger: Logger,
  limiter: RequestLimiter,
  label: string,
): Promise<T> {
  for (let attempt = 1; attempt <= config.retryAttempts; attempt += 1) {
    await limiter.wait();
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const payload = (await response.json()) as RpcResponse<T>;
      if (payload.error) {
        throw new Error(
          `Helius RPC ${payload.error.code ?? 'unknown'}: ${payload.error.message ?? 'unknown error'}`,
        );
      }
      return payload.result as T;
    }

    const retryAfterRaw = response.headers.get('retry-after');
    const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : 0;
    const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.ceil(retryAfterSec * 1000)
      : 0;
    const exponentialMs = config.retryBackoffMs * 2 ** (attempt - 1);
    const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(exponentialMs * 0.2)));
    const waitMs = Math.max(retryAfterMs, exponentialMs + jitterMs);

    if ((response.status === 429 || response.status >= 500) && attempt < config.retryAttempts) {
      await logger.warn(
        `Helius ${label} HTTP ${response.status}; retry ${attempt}/${config.retryAttempts} in ${waitMs}ms`,
      );
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Helius ${label} HTTP ${response.status}: ${response.statusText}`);
  }

  throw new Error(`Helius ${label} request failed after ${config.retryAttempts} attempts`);
}


const CACHE_VERSION = 3;
const PARSER_VERSION = 11;

type LightCacheFile = {
  version: number;
  token: string;
  parserVersion: number;
  createdAtMs: number;
  config: {
    activityBucketSec: number;
    fineActivityBucketSec: number;
    pageLimit: number;
    maxPages: number;
    maxSignatures: number;
  };
  pages: number;
  transactionsReturned: number;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
  truncated: boolean;
  bucketCounts: Array<[number, number]>;
  fineBucketCounts: Array<[number, number]>;
};

type FullCacheFile = {
  version: number;
  token: string;
  parserVersion: number;
  createdAtMs: number;
  startTimestamp: number;
  endTimestamp: number;
  result: Omit<FullScanResult, 'fullCacheHits' | 'fullCacheMisses'>;
};

function safeCacheName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

async function readFreshJson<T>(path: string, ttlSec: number): Promise<T | null> {
  if (ttlSec <= 0) return null;
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > ttlSec * 1000) return null;
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

function lightCachePath(token: string, config: Config): string {
  return `${config.heliusCacheDir}/light-${safeCacheName(token)}.json`;
}

function fullCachePath(token: string, startTimestamp: number, endTimestamp: number, config: Config): string {
  return `${config.heliusCacheDir}/full-${safeCacheName(token)}-${startTimestamp}-${endTimestamp}.json`;
}

function hydrateLightCache(
  cached: LightCacheFile,
  token: string,
  config: Config,
): ActivityScan | null {
  if (
    cached.version !== CACHE_VERSION ||
    cached.parserVersion !== PARSER_VERSION ||
    cached.token !== token ||
    cached.config.activityBucketSec !== config.activityBucketSec ||
    cached.config.fineActivityBucketSec !== config.fineActivityBucketSec ||
    cached.config.pageLimit !== config.heliusLightPageLimit ||
    cached.config.maxPages !== config.maxLightHistoryPages ||
    cached.config.maxSignatures !== config.maxLightSignatures
  ) return null;

  // A cache written under a looser density cap must not bypass the guard.
  if (cached.transactionsReturned > config.maxLightSignatures) return null;

  return {
    pages: cached.pages,
    transactionsReturned: cached.transactionsReturned,
    firstBlockTime: cached.firstBlockTime,
    lastBlockTime: cached.lastBlockTime,
    truncated: cached.truncated,
    bucketCounts: new Map(cached.bucketCounts),
    fineBucketCounts: new Map(cached.fineBucketCounts),
    cacheHit: true,
  };
}

/** Scan the entire token history with signatures only and keep only counters. */
async function scanActivityHistory(
  token: string,
  config: Config,
  logger: Logger,
  limiter: RequestLimiter,
): Promise<ActivityScan> {
  const cachePath = lightCachePath(token, config);
  if (config.heliusCacheEnabled) {
    const cached = await readFreshJson<LightCacheFile>(cachePath, config.heliusLightCacheTtlSec);
    if (cached) {
      const hydrated = hydrateLightCache(cached, token, config);
      if (hydrated) {
        await logger.info(`Light scan cache hit: ${cached.transactionsReturned} signatures`);
        return hydrated;
      }
    }
  }

  const rpcUrl = `${config.heliusRpcBaseUrl}/?api-key=${config.heliusApiKey}`;
  const bucketCounts = new Map<number, number>();
  const fineBucketCounts = new Map<number, number>();
  let paginationToken: string | undefined;
  let pages = 0;
  let transactionsReturned = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let truncated = false;

  while (pages < config.maxLightHistoryPages) {
    pages += 1;
    const params: Record<string, unknown> = {
      transactionDetails: 'signatures',
      sortOrder: 'asc',
      limit: config.heliusLightPageLimit,
      filters: {
        status: 'succeeded',
        tokenAccounts: 'balanceChanged',
      },
    };
    if (paginationToken) params.paginationToken = paginationToken;

    const result = await rpcRequest<RpcResult<SignatureRow>>(
      rpcUrl,
      {
        jsonrpc: '2.0',
        id: `light-${pages}`,
        method: 'getTransactionsForAddress',
        params: [token, params],
      },
      config,
      logger,
      limiter,
      'light-history',
    );

    const page = result?.data ?? [];
    transactionsReturned += page.length;

    // Density guard: ultra-dense tokens would split into more full-query
    // windows than this box can fetch (MAX_FULL_QUERY_WINDOWS) and keep in
    // RAM. Fail fast here — signatures-only pages are cheap — instead of
    // burning full-transaction credits for a scan that cannot complete.
    if (transactionsReturned > config.maxLightSignatures) {
      throw new Error(
        `Token ${token}: light scan reached ${transactionsReturned} signatures, above MAX_LIGHT_SIGNATURES=${config.maxLightSignatures}. ` +
        `Token too dense for this budget; skipping without full history (no truncation).`,
      );
    }

    for (const row of page) {
      if (typeof row.blockTime !== 'number' || !Number.isFinite(row.blockTime)) continue;
      firstBlockTime ??= row.blockTime;
      lastBlockTime = row.blockTime;
      addCount(bucketCounts, bucketStart(row.blockTime, config.activityBucketSec), 1);
      addCount(fineBucketCounts, bucketStart(row.blockTime, config.fineActivityBucketSec), 1);
    }

    await logger.info(
      `Light page ${pages}: ${page.length} signatures | total ${transactionsReturned}`,
    );

    paginationToken = result?.paginationToken;
    if (!paginationToken || page.length === 0) break;
  }

  if (paginationToken) truncated = true;

  const result: ActivityScan = {
    pages,
    transactionsReturned,
    firstBlockTime,
    lastBlockTime,
    truncated,
    bucketCounts,
    fineBucketCounts,
    cacheHit: false,
  };

  if (config.heliusCacheEnabled) {
    const cache: LightCacheFile = {
      version: CACHE_VERSION,
      token,
      parserVersion: PARSER_VERSION,
      createdAtMs: Date.now(),
      config: {
        activityBucketSec: config.activityBucketSec,
        fineActivityBucketSec: config.fineActivityBucketSec,
        pageLimit: config.heliusLightPageLimit,
        maxPages: config.maxLightHistoryPages,
        maxSignatures: config.maxLightSignatures,
      },
      pages,
      transactionsReturned,
      firstBlockTime,
      lastBlockTime,
      truncated,
      bucketCounts: [...bucketCounts.entries()],
      fineBucketCounts: [...fineBucketCounts.entries()],
    };
    await writeJson(cachePath, cache);
  }

  return result;
}

type CounterIndex = {
  timestamps: number[];
  prefix: number[];
};

// Cache indexes by Map identity so repeated planner range queries stay O(log n)
// without retaining indexes after the corresponding activity Map is released.
const COUNTER_INDEX_CACHE = new WeakMap<Map<number, number>, CounterIndex>();

function lowerBoundNumbers(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundNumbers(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function getCounterIndex(counts: Map<number, number>): CounterIndex {
  const cached = COUNTER_INDEX_CACHE.get(counts);
  if (cached) return cached;
  const timestamps = [...counts.keys()].sort((a, b) => a - b);
  const prefix: number[] = [0];
  for (const timestamp of timestamps) {
    prefix.push(prefix[prefix.length - 1]! + (counts.get(timestamp) ?? 0));
  }
  const index = { timestamps, prefix };
  COUNTER_INDEX_CACHE.set(counts, index);
  return index;
}

/** Return the sum of counts for a fixed bucket interval in O(log n). */
function countInRange(
  counts: Map<number, number>,
  startTimestamp: number,
  endTimestamp: number,
): number {
  if (startTimestamp > endTimestamp || counts.size === 0) return 0;
  const index = getCounterIndex(counts);
  const start = lowerBoundNumbers(index.timestamps, startTimestamp);
  const end = upperBoundNumbers(index.timestamps, endTimestamp);
  return index.prefix[end]! - index.prefix[start]!;
}

/** Select the busiest fixed-duration windows with a linear sliding-window sweep. */
function selectActiveWindows(
  bucketCounts: Map<number, number>,
  config: Config,
): ActiveWindowSelection[] {
  if (!bucketCounts.size) return [];

  const values = [...bucketCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, count]) => ({ timestamp, count }));
  const starts = values.map((value) => value.timestamp);
  const prefix: number[] = [0];
  for (const value of values) prefix.push(prefix.at(-1)! + value.count);

  type Ranked = ActiveWindowSelection & { score: number };
  const ranked: Ranked[] = [];
  let right = 0;
  for (let left = 0; left < values.length; left += 1) {
    if (right < left) right = left;
    const endExclusive = starts[left]! + config.activeWindowSec;
    while (right < values.length && values[right]!.timestamp < endExclusive) right += 1;
    const count = prefix[right]! - prefix[left]!;
    if (count >= config.minActiveWindowTransactions) {
      ranked.push({
        startTimestamp: starts[left]!,
        endTimestamp: endExclusive - 1,
        transactionCount: count,
        score: count,
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.startTimestamp - b.startTimestamp);
  if (ranked.length === 0) {
    for (let left = 0; left < values.length; left += 1) {
      const endExclusive = starts[left]! + config.activeWindowSec;
      const count = prefix[upperBoundNumbers(starts, endExclusive - 1)]! - prefix[left]!;
      ranked.push({
        startTimestamp: starts[left]!,
        endTimestamp: endExclusive - 1,
        transactionCount: count,
        score: count,
      });
    }
    ranked.sort((a, b) => b.score - a.score || a.startTimestamp - b.startTimestamp);
  }

  const selected: ActiveWindowSelection[] = [];
  for (const candidate of ranked) {
    if (selected.some(
      (window) => candidate.startTimestamp <= window.endTimestamp + config.activeWindowMergeGapSec
        && candidate.endTimestamp >= window.startTimestamp - config.activeWindowMergeGapSec,
    )) continue;
    selected.push({ ...candidate });
    if (selected.length >= config.activeWindowCount) break;
  }
  return selected.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

/**
 * Select low-activity windows shortly before hot windows. These are deliberate
 * reconnaissance ranges for quiet accumulation that a busiest-window-only scan
 * would miss. The output remains small so full-history cost stays bounded.
 */
function selectQuietWindows(
  bucketCounts: Map<number, number>,
  activeWindows: ActiveWindowSelection[],
  config: Config,
): QuietWindowSelection[] {
  if (!bucketCounts.size || !activeWindows.length || config.quietWindowCount <= 0) return [];

  const values = [...bucketCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, count]) => ({ timestamp, count }));
  const timestamps = values.map((value) => value.timestamp);
  const prefix: number[] = [0];
  for (const value of values) prefix.push(prefix.at(-1)! + value.count);

  type Candidate = ActiveWindowSelection & { relativeDistance: number };
  const candidates: Candidate[] = [];

  for (const active of activeWindows) {
    const searchStart = active.startTimestamp - config.quietSearchEndSec;
    const searchEnd = active.startTimestamp - config.quietSearchStartSec - config.quietWindowSec;
    if (searchEnd < searchStart) continue;

    const first = lowerBoundNumbers(timestamps, searchStart);
    const lastExclusive = upperBoundNumbers(timestamps, searchEnd);
    for (let i = first; i < lastExclusive; i += 1) {
      const start = timestamps[i]!;
      const endExclusive = start + config.quietWindowSec;
      if (endExclusive > searchEnd + config.quietWindowSec) continue;
      const right = upperBoundNumbers(timestamps, endExclusive - 1);
      const count = prefix[right]! - prefix[i]!;
      if (count < config.minQuietWindowTransactions || count <= 0) continue;
      if (activeWindows.some(
        (other) => start <= other.endTimestamp && endExclusive - 1 >= other.startTimestamp,
      )) continue;
      candidates.push({
        startTimestamp: start,
        endTimestamp: endExclusive - 1,
        transactionCount: count,
        relativeDistance: active.startTimestamp - start,
      });
    }
  }

  // Prefer quiet windows with non-zero but low activity, while avoiding many
  // nearly identical candidates around the same active region.
  candidates.sort((a, b) => a.transactionCount - b.transactionCount || a.relativeDistance - b.relativeDistance || a.startTimestamp - b.startTimestamp);
  const selected: QuietWindowSelection[] = [];
  for (const candidate of candidates) {
    if (selected.some(
      (window) => candidate.startTimestamp <= window.endTimestamp + config.activeWindowMergeGapSec
        && candidate.endTimestamp >= window.startTimestamp - config.activeWindowMergeGapSec,
    )) continue;
    selected.push({
      startTimestamp: candidate.startTimestamp,
      endTimestamp: candidate.endTimestamp,
      transactionCount: candidate.transactionCount,
    });
    if (selected.length >= config.quietWindowCount) break;
  }
  return selected.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

/** Build full-fetch ranges by unioning active and quiet windows before splitting. */
function buildBaseFullWindows(
  activeWindows: ActiveWindowSelection[],
  quietWindows: QuietWindowSelection[],
  fineCounts: Map<number, number>,
  config: Config,
): TimeWindow[] {
  const raw: TimeWindow[] = [];
  for (const window of activeWindows) {
    const start = Math.max(0, window.startTimestamp - config.activeWindowContextSec);
    const end = window.endTimestamp + config.activeWindowContextSec;
    raw.push({ startTimestamp: start, endTimestamp: end, estimatedTransactions: countInRange(fineCounts, start, end) });
  }
  for (const window of quietWindows) {
    const start = Math.max(0, window.startTimestamp - config.quietWindowContextSec);
    const end = window.endTimestamp + config.quietWindowContextSec;
    raw.push({ startTimestamp: start, endTimestamp: end, estimatedTransactions: countInRange(fineCounts, start, end) });
  }
  return mergeTimeWindows(raw, config.fullWindowMergeGapSec, fineCounts);
}

/** Merge temporal overlaps unconditionally; recompute estimates on the union. */
function mergeTimeWindows(
  windows: TimeWindow[],
  mergeGapSec: number,
  fineCounts: Map<number, number>,
): TimeWindow[] {
  const sorted = [...windows].sort((a, b) => a.startTimestamp - b.startTimestamp || a.endTimestamp - b.endTimestamp);
  const merged: TimeWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.startTimestamp <= previous.endTimestamp + mergeGapSec) {
      previous.endTimestamp = Math.max(previous.endTimestamp, window.endTimestamp);
      previous.estimatedTransactions = countInRange(fineCounts, previous.startTimestamp, previous.endTimestamp);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/** Split a merged range recursively using already-collected fine activity counts. */
function splitTimeWindow(
  window: TimeWindow,
  fineCounts: Map<number, number>,
  config: Config,
): TimeWindow[] {
  if (window.estimatedTransactions <= config.maxFullTransactionsPerWindow) return [window];
  const duration = window.endTimestamp - window.startTimestamp + 1;
  if (duration <= config.fineActivityBucketSec) return [window];

  const midpoint = Math.floor((window.startTimestamp + window.endTimestamp) / 2);
  const left: TimeWindow = {
    startTimestamp: window.startTimestamp,
    endTimestamp: midpoint,
    estimatedTransactions: countInRange(fineCounts, window.startTimestamp, midpoint),
  };
  const right: TimeWindow = {
    startTimestamp: midpoint + 1,
    endTimestamp: window.endTimestamp,
    estimatedTransactions: countInRange(fineCounts, midpoint + 1, window.endTimestamp),
  };
  return [
    ...splitTimeWindow(left, fineCounts, config),
    ...splitTimeWindow(right, fineCounts, config),
  ];
}

/** Build deterministic, non-overlapping full query windows. */
function planFullWindows(
  activeWindows: ActiveWindowSelection[],
  quietWindows: QuietWindowSelection[],
  fineCounts: Map<number, number>,
  config: Config,
): TimeWindow[] {
  const merged = buildBaseFullWindows(activeWindows, quietWindows, fineCounts, config);
  const planned = merged.flatMap((window) => splitTimeWindow(window, fineCounts, config));
  if (planned.length > config.maxFullQueryWindows) {
    throw new Error(
      `Full-query planning requires ${planned.length} windows, above MAX_FULL_QUERY_WINDOWS=${config.maxFullQueryWindows}. No full history was truncated; increase the safety limit or reduce active/quiet window selection.`,
    );
  }
  return planned.sort((a, b) => a.startTimestamp - b.startTimestamp);
}

/** Fetch full transaction objects for planned windows and parse each page immediately. */
async function fetchFullWindows(
  token: string,
  windows: TimeWindow[],
  config: Config,
  logger: Logger,
  limiter: RequestLimiter,
): Promise<FullScanResult> {
  const rpcUrl = `${config.heliusRpcBaseUrl}/?api-key=${config.heliusApiKey}`;
  const uniqueTrades = new Map<string, Trade>();
  const parseDropCounts: ParseDropCounts = {
    accepted_transactions: 0,
    accepted_trades: 0,
    failed_transaction: 0,
    missing_block_time: 0,
    missing_signature: 0,
    no_token_balance: 0,
    token_delta_zero: 0,
    wallet_not_signer: 0,
    missing_wallet_sol_balance: 0,
    zero_sol_delta: 0,
    sol_direction_mismatch: 0,
    router_like_swap: 0,
    invalid_amount: 0,
  };

  let pages = 0;
  let transactionsReturned = 0;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let truncated = false;
  let fullCacheHits = 0;
  let fullCacheMisses = 0;

  for (const [windowIndex, window] of windows.entries()) {
    if (config.heliusCacheEnabled) {
      const cachePath = fullCachePath(token, window.startTimestamp, window.endTimestamp, config);
      const cached = await readFreshJson<FullCacheFile>(cachePath, config.heliusFullCacheTtlSec);
      if (cached
        && cached.version === CACHE_VERSION
        && cached.parserVersion === PARSER_VERSION
        && cached.token === token
        && cached.startTimestamp === window.startTimestamp
        && cached.endTimestamp === window.endTimestamp
      ) {
        fullCacheHits += 1;
        await logger.info(`Full window ${windowIndex + 1}/${windows.length}: cache hit | ${cached.result.transactionsReturned} tx | trades ${cached.result.trades.length}`);
        for (const trade of cached.result.trades) {
          const key = `${trade.signature}:${trade.wallet}`;
          const existing = uniqueTrades.get(key);
          if (!existing || trade.slot < existing.slot) uniqueTrades.set(key, trade);
        }
        transactionsReturned += cached.result.transactionsReturned;
        if (cached.result.firstBlockTime !== null) firstBlockTime = firstBlockTime === null ? cached.result.firstBlockTime : Math.min(firstBlockTime, cached.result.firstBlockTime);
        if (cached.result.lastBlockTime !== null) lastBlockTime = lastBlockTime === null ? cached.result.lastBlockTime : Math.max(lastBlockTime, cached.result.lastBlockTime);
        pages += cached.result.pages;
        for (const [key, value] of Object.entries(cached.result.parseDropCounts) as Array<[keyof ParseDropCounts, number]>) {
          parseDropCounts[key] += value;
        }
        continue;
      }
    }

    fullCacheMisses += 1;
    let paginationToken: string | undefined;
    let windowTransactions = 0;
    let windowPages = 0;
    let windowFirstBlockTime: number | null = null;
    let windowLastBlockTime: number | null = null;
    const windowParseDropCounts: ParseDropCounts = {
      accepted_transactions: 0,
      accepted_trades: 0,
      failed_transaction: 0,
      missing_block_time: 0,
      missing_signature: 0,
      no_token_balance: 0,
      token_delta_zero: 0,
      wallet_not_signer: 0,
      missing_wallet_sol_balance: 0,
      zero_sol_delta: 0,
      sol_direction_mismatch: 0,
    router_like_swap: 0,
      invalid_amount: 0,
    };

    await logger.info(
      `Full window ${windowIndex + 1}/${windows.length}: ${new Date(window.startTimestamp * 1000).toISOString()} -> ${new Date(window.endTimestamp * 1000).toISOString()} | estimated ${window.estimatedTransactions}`,
    );

    while (true) {
      pages += 1;
      windowPages += 1;
      if (windowPages > config.maxHistoryPages) {
        throw new Error(`Full query window exceeded MAX_HISTORY_PAGES=${config.maxHistoryPages}; window=${window.startTimestamp}-${window.endTimestamp}. No truncation is allowed.`);
      }
      const params: Record<string, unknown> = {
        transactionDetails: 'full',
        sortOrder: 'asc',
        limit: config.heliusPageLimit,
        filters: {
          blockTime: {
            gte: window.startTimestamp,
            lte: window.endTimestamp,
          },
          status: 'succeeded',
          tokenAccounts: 'balanceChanged',
        },
        maxSupportedTransactionVersion: 1,
      };
      if (paginationToken) params.paginationToken = paginationToken;

      const result = await rpcRequest<RpcResult<RawTransaction>>(
        rpcUrl,
        {
          jsonrpc: '2.0',
          id: `full-${windowIndex + 1}-${pages}`,
          method: 'getTransactionsForAddress',
          params: [token, params],
        },
        config,
        logger,
        limiter,
        'full-history',
      );

      const page = result?.data ?? [];
      transactionsReturned += page.length;
      windowTransactions += page.length;

      for (const transaction of page) {
        const detailed = parseTradesFromTransactionDetailed(transaction, token);
        // detailed.reason is already 'accepted_transactions' when trades were
        // parsed (one count per transaction). Counting it again here used to
        // double accepted_transactions (2x accepted_trades pattern in logs).
        parseDropCounts[detailed.reason] += 1;
        windowParseDropCounts[detailed.reason] += 1;
        parseDropCounts.accepted_trades += detailed.trades.length;
        windowParseDropCounts.accepted_trades += detailed.trades.length;

        if (transaction.blockTime !== null) {
          firstBlockTime ??= transaction.blockTime;
          lastBlockTime = transaction.blockTime;
          windowFirstBlockTime ??= transaction.blockTime;
          windowLastBlockTime = transaction.blockTime;
        }

        for (const trade of detailed.trades) {
          const key = `${trade.signature}:${trade.wallet}`;
          const existing = uniqueTrades.get(key);
          if (!existing || trade.slot < existing.slot) uniqueTrades.set(key, trade);
        }
      }

      await logger.info(
        `Full page ${pages}: ${page.length} tx | window ${windowTransactions} | trades ${uniqueTrades.size}`,
      );

      paginationToken = result?.paginationToken;
      if (!paginationToken || page.length === 0) break;
    }

    if (config.heliusCacheEnabled) {
      const cachedResult: Omit<FullScanResult, 'fullCacheHits' | 'fullCacheMisses'> = {
        trades: [...uniqueTrades.values()].filter((trade) => trade.timestamp >= window.startTimestamp && trade.timestamp <= window.endTimestamp),
        pages: windowPages,
        transactionsReturned: windowTransactions,
        firstBlockTime: windowFirstBlockTime,
        lastBlockTime: windowLastBlockTime,
        truncated: false,
        parseDropCounts: windowParseDropCounts,
      };
      const cache: FullCacheFile = {
        version: CACHE_VERSION,
        token,
        parserVersion: PARSER_VERSION,
        createdAtMs: Date.now(),
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        result: cachedResult,
      };
      await writeJson(fullCachePath(token, window.startTimestamp, window.endTimestamp, config), cache);
    }
  }

  return {
    trades: [...uniqueTrades.values()].sort((a, b) => a.timestamp - b.timestamp || a.slot - b.slot),
    pages,
    transactionsReturned,
    firstBlockTime,
    lastBlockTime,
    truncated,
    parseDropCounts,
    fullCacheHits,
    fullCacheMisses,
  };
}

/**
 * Memory-safe targeted historical scanner.
 *
 * First scan signatures only, selecting the busiest 5-minute regions. Then fetch
 * full transaction objects only for those regions, splitting very dense ranges
 * until their expected transaction count fits the configured memory budget.
 */
export async function fetchTransactions(
  token: string,
  config: Config,
  logger: Logger,
): Promise<FetchResult> {
  const limiter = new RequestLimiter(config.heliusMinIntervalMs);
  const light = await scanActivityHistory(token, config, logger, limiter);
  const activeWindows = selectActiveWindows(light.bucketCounts, config);
  const quietWindows = selectQuietWindows(light.bucketCounts, activeWindows, config);

  await logger.info(
    `Activity selection: active=${activeWindows.length} quiet=${quietWindows.length} | light tx=${light.transactionsReturned}` ,
  );

  if (!activeWindows.length) {
    return {
      trades: [],
      pages: 0,
      transactionsReturned: 0,
      firstBlockTime: null,
      lastBlockTime: null,
      truncated: false,
      lightweightPages: light.pages,
      lightweightTransactionsReturned: light.transactionsReturned,
      lightweightFirstBlockTime: light.firstBlockTime,
      lightweightLastBlockTime: light.lastBlockTime,
      lightweightTruncated: light.truncated,
      lightweightCacheHit: light.cacheHit,
      activeWindows: [],
      quietWindows: [],
      fullQueryWindows: 0,
      fullCacheHits: 0,
      fullCacheMisses: 0,
      parseDropCounts: {
        accepted_transactions: 0,
        accepted_trades: 0,
        failed_transaction: 0,
        missing_block_time: 0,
        missing_signature: 0,
        no_token_balance: 0,
        token_delta_zero: 0,
        wallet_not_signer: 0,
        missing_wallet_sol_balance: 0,
        zero_sol_delta: 0,
        sol_direction_mismatch: 0,
    router_like_swap: 0,
        invalid_amount: 0,
      },
    };
  }

  const windows = planFullWindows(
    activeWindows,
    quietWindows,
    light.fineBucketCounts,
    config,
  );

  await logger.info(`Full query planning: ${windows.length} non-overlapping windows`);

  const full = await fetchFullWindows(token, windows, config, logger, limiter);

  return {
    ...full,
    lightweightPages: light.pages,
    lightweightTransactionsReturned: light.transactionsReturned,
    lightweightFirstBlockTime: light.firstBlockTime,
    lightweightLastBlockTime: light.lastBlockTime,
    lightweightTruncated: light.truncated,
    lightweightCacheHit: light.cacheHit,
    activeWindows,
    quietWindows,
    fullQueryWindows: windows.length,
    fullCacheHits: full.fullCacheHits,
    fullCacheMisses: full.fullCacheMisses,
  };
}
