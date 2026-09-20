/**
 * DeBot final logger.
 *
 * Exactly two persistent files are maintained:
 *   logs/debot/signals.json
 *   logs/debot/signals.csv
 *
 * Both files contain the same flat signal observations. This keeps the module
 * easy to inspect manually while remaining convenient for pandas/Polars/DuckDB.
 */

import { access, appendFile, mkdir, open, stat, writeFile } from "node:fs/promises";
import type { DeBotTrendingSignal, DeBotTrendingSnapshot } from "./debot_client";

export type DeBotLoggerConfig = { directory: string };

const COLUMNS = [
  "fetched_at", "observed_at_sec", "address", "symbol", "name", "presence",
  "rank_1m", "rank_5m", "rank_delta_5m_minus_1m",
  "activity_score", "activity_evidence_count", "activity_weight",
  "activity_rank_1m_component", "activity_rank_5m_component", "activity_intensity_component",
  "pump_precursor_score", "pump_precursor_evidence_count", "pump_precursor_positive_evidence_count", "pump_precursor_weight",
  "pump_buy_pressure_component", "pump_buy_pressure_delta_component", "pump_volume_component", "pump_wallet_component",
  "is_trending", "is_pump_precursor_candidate", "candidate_reason",
  "activity_score_1m", "activity_score_5m", "activity_score_delta_1m_minus_5m", "activity_intensity_ratio",
  "price", "price_change_1m", "price_change_5m", "price_change_1h", "price_change_24h", "max_price_gain",
  "buys_1m", "sells_1m", "swaps_1m", "buy_volume_1m", "sell_volume_1m", "volume_1m", "unique_wallet_swaps_1m", "buy_pressure_1m",
  "buys_5m", "sells_5m", "swaps_5m", "buy_volume_5m", "sell_volume_5m", "volume_5m", "unique_wallet_swaps_5m", "buy_pressure_5m",
  "buy_pressure_delta_1m_minus_5m", "volume_acceleration", "wallet_acceleration",
  "liquidity", "holders", "market_cap", "fdv",
  "smart_wallet_online_1m", "smart_wallet_total_1m", "smart_wallet_coverage_1m",
  "smart_wallet_online_5m", "smart_wallet_total_5m", "smart_wallet_coverage_5m",
  "token_tier", "launchpad", "tags", "from_launchpad", "safe_mint_abandoned", "safe_block_address",
  "creator_address", "creation_timestamp", "last_update_time_1m", "last_update_time_5m",
  "heatmap_seen", "heatmap_occurrence_count", "heatmap_first_seen_sec", "heatmap_last_seen_sec", "heatmap_recency_sec",
  "heatmap_market_wallet_count", "heatmap_market_trade_volume", "heatmap_previous_market_wallet_count", "heatmap_previous_market_trade_volume",
  "heatmap_market_wallet_acceleration", "heatmap_market_volume_acceleration",
  "signal_count", "signal_first_time_sec", "signal_first_price", "signal_max_price", "signal_max_price_gain", "signal_token_level",
  "heatmap_to_signal_lag_sec", "heatmap_seen_before_signal",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function values(snapshot: DeBotTrendingSnapshot, signal: DeBotTrendingSignal): unknown[] {
  return [
    snapshot.fetchedAt, snapshot.observedAtSec, signal.address, signal.symbol, signal.name, signal.presence,
    signal.rank1m, signal.rank5m, signal.rankDelta5mMinus1m,
    signal.activityScore, signal.activityEvidenceCount, signal.activityWeight,
    signal.activityRank1mComponent, signal.activityRank5mComponent, signal.activityIntensityComponent,
    signal.pumpPrecursorScore, signal.pumpPrecursorEvidenceCount, signal.pumpPrecursorPositiveEvidenceCount, signal.pumpPrecursorWeight,
    signal.pumpBuyPressureComponent, signal.pumpBuyPressureDeltaComponent, signal.pumpVolumeComponent, signal.pumpWalletComponent,
    signal.isTrending, signal.isPumpPrecursorCandidate, signal.candidateReason,
    signal.activityScore1m, signal.activityScore5m, signal.activityScoreDelta1mMinus5m, signal.activityIntensityRatio,
    signal.price, signal.priceChange1m, signal.priceChange5m, signal.priceChange1h, signal.priceChange24h, signal.maxPriceGain,
    signal.buys1m, signal.sells1m, signal.swaps1m, signal.buyVolume1m, signal.sellVolume1m, signal.volume1m, signal.uniqueWalletSwaps1m, signal.buyPressure1m,
    signal.buys5m, signal.sells5m, signal.swaps5m, signal.buyVolume5m, signal.sellVolume5m, signal.volume5m, signal.uniqueWalletSwaps5m, signal.buyPressure5m,
    signal.buyPressureDelta1mMinus5m, signal.volumeAcceleration, signal.walletAcceleration,
    signal.liquidity, signal.holders, signal.marketCap, signal.fdv,
    signal.smartWalletOnlineCount1m, signal.smartWalletTotalCount1m, signal.smartWalletCoverage1m,
    signal.smartWalletOnlineCount5m, signal.smartWalletTotalCount5m, signal.smartWalletCoverage5m,
    signal.tokenTier, signal.launchpad, signal.tags, signal.fromLaunchpad, signal.safeMintAbandoned, signal.safeBlockAddress,
    signal.creatorAddress, signal.creationTimestamp, signal.lastUpdateTime1m, signal.lastUpdateTime5m,
    signal.heatmapSeen, signal.heatmapOccurrenceCount, signal.heatmapFirstSeenSec, signal.heatmapLastSeenSec, signal.heatmapRecencySec,
    signal.latestMarketWalletCount, signal.latestMarketTradeVolume, signal.previousMarketWalletCount, signal.previousMarketTradeVolume,
    signal.marketWalletAcceleration, signal.marketVolumeAcceleration,
    signal.signalCount, signal.signalFirstTimeSec, signal.signalFirstPrice, signal.signalMaxPrice, signal.signalMaxPriceGain, signal.signalTokenLevel,
    signal.heatmapToSignalLagSec, signal.heatmapSeenBeforeSignal,
  ];
}

/** Logger that intentionally creates exactly signals.json and signals.csv. */
export class DeBotFileLogger {
  private readonly directory: string;
  private readonly jsonPath: string;
  private readonly csvPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(config: DeBotLoggerConfig) {
    if (!config.directory.trim()) throw new Error("log directory must not be empty");
    this.directory = config.directory;
    this.jsonPath = `${config.directory}/signals.json`;
    this.csvPath = `${config.directory}/signals.csv`;
  }

  /** Append a complete normalized snapshot to both files. */
  async logSnapshot(snapshot: DeBotTrendingSnapshot): Promise<void> {
    await this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.appendJson(snapshot);
      await this.appendCsv(snapshot);
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async appendJson(snapshot: DeBotTrendingSnapshot): Promise<void> {
    const rows = snapshot.signals.map((signal) => ({
      fetchedAt: snapshot.fetchedAt,
      observedAtSec: snapshot.observedAtSec,
      ...signal,
    }));
    if (rows.length === 0) return;

    if (!(await exists(this.jsonPath))) await writeFile(this.jsonPath, "[\n]\n", "utf8");
    const handle = await open(this.jsonPath, "r+");
    try {
      const info = await handle.stat();
      if (info.size < 3) {
        await handle.truncate(0);
        await handle.write("[\n]\n", 0, "utf8");
      }
      const refreshed = await handle.stat();
      const position = Math.max(0, refreshed.size - 3);
      const prefix = refreshed.size <= 4 ? "" : ",\n";
      const payload = `${prefix}${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
      await handle.write(payload, position, "utf8");
    } finally {
      await handle.close();
    }
  }

  private async appendCsv(snapshot: DeBotTrendingSnapshot): Promise<void> {
    if (snapshot.signals.length === 0) return;
    if (!(await exists(this.csvPath))) {
      await writeFile(this.csvPath, `${COLUMNS.join(",")}\n`, "utf8");
    } else if ((await stat(this.csvPath)).size === 0) {
      await writeFile(this.csvPath, `${COLUMNS.join(",")}\n`, "utf8");
    }
    const rows = snapshot.signals.map((signal) => values(snapshot, signal).map(csvCell).join(","));
    await appendFile(this.csvPath, `${rows.join("\n")}\n`, "utf8");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
