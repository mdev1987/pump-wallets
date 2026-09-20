import { mkdir } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import type { Config } from './config';
import type {
  AnalysisResponse,
  ControlBaseline,
  PumpBuyEventOutput,
  PumpWindow,
  WalletLeader,
  WalletPumpObservation,
} from './analyzer';
import type { Logger } from './logger';
import type { DeBotTrendingSignal, DeBotTrendingSnapshot } from './debot_client';


/**
 * SQL value accepted by the DuckDB parameter binder.
 *
 * The integrated scanner uses parameterized INSERT statements instead of the
 * Node Neo Appender API because Bun 1.4.x does not expose all documented
 * appender methods consistently. This keeps the storage path portable across
 * Bun and Node while still avoiding SQL string interpolation for data values.
 */
type SqlValue = string | number | bigint | boolean | null;

/** Quote a fixed internal table identifier. */
function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe DuckDB identifier: ${identifier}`);
  }
  return `\"${identifier}\"`;
}

/** Convert undefined values to SQL NULL before binding. */
function sqlValue(value: unknown): SqlValue {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return value;
  }
  throw new Error(`Unsupported SQL value type: ${typeof value}`);
}

/**
 * Persistent multi-token research database.
 *
 * The database is deliberately analytical: token results are normalized into
 * tables that can be joined and aggregated across hundreds or thousands of
 * tokens without repeatedly parsing JSON files.
 */
export class ResearchDb {
  private constructor(
    private readonly connection: Awaited<ReturnType<DuckDBInstance['connect']>>,
  ) {}

  /** Open/create the shared DuckDB file and initialize its schema. */
  static async open(config: Config, logger: Logger): Promise<ResearchDb> {
    const slash = config.duckdbPath.lastIndexOf('/');
    if (slash > 0) await mkdir(config.duckdbPath.slice(0, slash), { recursive: true });

    await logger.info(`Opening DuckDB: ${config.duckdbPath}`);
    // Clamp threads for 1-2 vCPU boxes; DuckDB defaults would oversubscribe.
    const threads = Math.max(1, Math.min(config.duckdbThreads, 2));
    const instance = await DuckDBInstance.create(config.duckdbPath, {
      threads: String(threads),
    });
    const connection = await instance.connect();
    const db = new ResearchDb(connection);
    // Bound analytical memory on small VPS (2GB): spill to disk, not OOM.
    // 600MB leaves headroom for Bun (~150-250MB) + OS within 2GB.
    try {
      await connection.run(`SET threads TO ${threads}`);
    } catch { /* older builds ignore SET threads */ }
    try {
      await connection.run(`SET memory_limit='600MB'`);
    } catch { /* ignore if unsupported */ }
    try {
      await mkdir('./data/tmp', { recursive: true });
      await connection.run(`SET temp_directory='./data/tmp'`);
    } catch { /* ignore if unsupported */ }
    try {
      await connection.run(`SET checkpoint_threshold='64MB'`);
    } catch { /* ignore if unsupported */ }
    await db.initializeSchema();
    // Reclaim WAL on open so repeated DeBot-only runs don't grow it unbounded.
    try {
      await connection.run(`CHECKPOINT`);
    } catch { /* ignore */ }
    return db;
  }

  /** Create the normalized research schema once. */
  private async initializeSchema(): Promise<void> {
    await this.connection.run(`
      CREATE TABLE IF NOT EXISTS tokens (
        token_ca VARCHAR PRIMARY KEY,
        analysis_version INTEGER NOT NULL,
        scanned_at VARCHAR NOT NULL,
        history_pages INTEGER NOT NULL,
        transactions_returned BIGINT NOT NULL,
        history_truncated BOOLEAN NOT NULL,
        first_block_time VARCHAR,
        last_block_time VARCHAR,
        detected_trades BIGINT NOT NULL,
        market_buckets BIGINT NOT NULL,
        pump_starts INTEGER NOT NULL,
        pump_windows INTEGER NOT NULL,
        strongest_pump_start_time VARCHAR,
        strongest_pump_end_time VARCHAR,
        strongest_pump_return DOUBLE,
        strongest_pump_buy_sol DOUBLE,
        scan_source VARCHAR NOT NULL DEFAULT 'cli',
        debot_observed_at VARCHAR,
        debot_rank_1m INTEGER,
        debot_rank_5m INTEGER,
        debot_activity_score DOUBLE,
        debot_pump_precursor_score DOUBLE,
        scan_strategy VARCHAR NOT NULL DEFAULT 'active-hours',
        lightweight_pages INTEGER NOT NULL DEFAULT 0,
        lightweight_transactions_returned BIGINT NOT NULL DEFAULT 0,
        lightweight_first_block_time VARCHAR,
        lightweight_last_block_time VARCHAR,
        lightweight_truncated BOOLEAN NOT NULL DEFAULT FALSE,
        selected_active_hours INTEGER NOT NULL DEFAULT 0,
        selected_active_windows INTEGER NOT NULL DEFAULT 0,
        full_query_windows INTEGER NOT NULL DEFAULT 0,
        selected_active_hours_json VARCHAR,
        active_windows_json VARCHAR,
        parse_drop_counts_json VARCHAR,
        selected_quiet_windows INTEGER NOT NULL DEFAULT 0,
        quiet_windows_json VARCHAR,
        lightweight_cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
        full_cache_hits INTEGER NOT NULL DEFAULT 0,
        full_cache_misses INTEGER NOT NULL DEFAULT 0,
        run_id VARCHAR,
        scan_started_at VARCHAR,
        scan_completed_at VARCHAR,
        scan_status VARCHAR NOT NULL DEFAULT 'completed',
        scan_error VARCHAR
      );

      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_source VARCHAR DEFAULT 'cli';
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS debot_observed_at VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS debot_rank_1m INTEGER;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS debot_rank_5m INTEGER;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS debot_activity_score DOUBLE;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS debot_pump_precursor_score DOUBLE;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_strategy VARCHAR DEFAULT 'active-hours';
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lightweight_pages INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lightweight_transactions_returned BIGINT DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lightweight_first_block_time VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lightweight_last_block_time VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lightweight_truncated BOOLEAN DEFAULT FALSE;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS selected_active_hours INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS selected_active_windows INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS full_query_windows INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS selected_active_hours_json VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS active_windows_json VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS parse_drop_counts_json VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS selected_quiet_windows INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS quiet_windows_json VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lightweight_cache_hit BOOLEAN DEFAULT FALSE;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS full_cache_hits INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS full_cache_misses INTEGER DEFAULT 0;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_started_at VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_completed_at VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_status VARCHAR DEFAULT 'completed';
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_error VARCHAR;
      CREATE TABLE IF NOT EXISTS pump_windows (
        token_ca VARCHAR NOT NULL,
        pump_id INTEGER NOT NULL,
        start_timestamp BIGINT NOT NULL,
        start_time VARCHAR NOT NULL,
        end_timestamp BIGINT NOT NULL,
        end_time VARCHAR NOT NULL,
        start_price_sol DOUBLE NOT NULL,
        peak_price_sol DOUBLE NOT NULL,
        peak_timestamp BIGINT NOT NULL,
        peak_return DOUBLE NOT NULL,
        max15s_return DOUBLE NOT NULL,
        max30s_return DOUBLE NOT NULL,
        net_buy_sol DOUBLE NOT NULL,
        buy_sol DOUBLE NOT NULL,
        sell_sol DOUBLE NOT NULL,
        buy_count INTEGER NOT NULL,
        sell_count INTEGER NOT NULL,
        PRIMARY KEY (token_ca, pump_id)
      );

      CREATE TABLE IF NOT EXISTS control_baselines (
        token_ca VARCHAR NOT NULL,
        pump_id INTEGER NOT NULL,
        pump_start_time VARCHAR NOT NULL,
        window_start_time VARCHAR NOT NULL,
        window_end_time VARCHAR NOT NULL,
        buy_count INTEGER NOT NULL,
        buy_sol DOUBLE NOT NULL,
        available_buy_count INTEGER NOT NULL,
        available_buy_sol DOUBLE NOT NULL,
        forward5_median DOUBLE,
        forward15_median DOUBLE,
        forward30_median DOUBLE,
        forward60_median DOUBLE,
        positive5_rate DOUBLE,
        positive15_rate DOUBLE,
        positive30_rate DOUBLE,
        positive60_rate DOUBLE,
        PRIMARY KEY (token_ca, pump_id)
      );

      CREATE TABLE IF NOT EXISTS wallet_pump_observations (
        token_ca VARCHAR NOT NULL,
        wallet VARCHAR NOT NULL,
        pump_id INTEGER NOT NULL,
        pump_start_time VARCHAR NOT NULL,
        pump_end_time VARCHAR NOT NULL,
        pump_return DOUBLE NOT NULL,
        pump_buy_sol DOUBLE NOT NULL,
        buy_count INTEGER NOT NULL,
        pre_pump_buy_count INTEGER NOT NULL,
        pre_pump_buy_sol DOUBLE NOT NULL,
        early_pump_buy_count INTEGER NOT NULL DEFAULT 0,
        early_pump_buy_sol DOUBLE NOT NULL DEFAULT 0,
        control_sufficient BOOLEAN NOT NULL DEFAULT FALSE,
        control_shortfall_reason VARCHAR,
        median_seconds_before_pump DOUBLE,
        p25_seconds_before_pump DOUBLE,
        p75_seconds_before_pump DOUBLE,
        earliest_seconds_before_pump DOUBLE,
        lead1s_count INTEGER NOT NULL,
        lead3s_count INTEGER NOT NULL,
        lead5s_count INTEGER NOT NULL,
        lead10s_count INTEGER NOT NULL,
        lead15s_count INTEGER NOT NULL,
        lead1s_sol DOUBLE NOT NULL,
        lead3s_sol DOUBLE NOT NULL,
        lead5s_sol DOUBLE NOT NULL,
        lead10s_sol DOUBLE NOT NULL,
        lead15s_sol DOUBLE NOT NULL,
        median_pump_buy_flow_share DOUBLE,
        max_pump_buy_flow_share DOUBLE,
        median_local_buy_flow_share DOUBLE,
        max_local_buy_flow_share DOUBLE,
        forward1_median DOUBLE,
        forward3_median DOUBLE,
        forward5_median DOUBLE,
        forward10_median DOUBLE,
        forward15_median DOUBLE,
        forward30_median DOUBLE,
        forward60_median DOUBLE,
        max_forward15_median DOUBLE,
        max_forward30_median DOUBLE,
        positive15_rate DOUBLE,
        positive30_rate DOUBLE,
        positive60_rate DOUBLE,
        lead_evidence_score DOUBLE NOT NULL,
        control_buy_count INTEGER NOT NULL,
        control_buy_sol DOUBLE NOT NULL,
        control_available_buy_count INTEGER NOT NULL,
        control_available_buy_sol DOUBLE NOT NULL,
        control_forward5_median DOUBLE,
        control_forward15_median DOUBLE,
        control_forward30_median DOUBLE,
        control_forward60_median DOUBLE,
        control_positive15_rate DOUBLE,
        control_positive30_rate DOUBLE,
        control_positive60_rate DOUBLE,
        excess_forward5_median DOUBLE,
        excess_forward15_median DOUBLE,
        excess_forward30_median DOUBLE,
        excess_forward60_median DOUBLE,
        positive15_lift DOUBLE,
        positive30_lift DOUBLE,
        positive60_lift DOUBLE,
        PRIMARY KEY (token_ca, wallet, pump_id)
      );

      ALTER TABLE wallet_pump_observations ADD COLUMN IF NOT EXISTS early_pump_buy_count INTEGER DEFAULT 0;
      ALTER TABLE wallet_pump_observations ADD COLUMN IF NOT EXISTS early_pump_buy_sol DOUBLE DEFAULT 0;
      ALTER TABLE wallet_pump_observations ADD COLUMN IF NOT EXISTS control_sufficient BOOLEAN DEFAULT FALSE;
      ALTER TABLE wallet_pump_observations ADD COLUMN IF NOT EXISTS control_shortfall_reason VARCHAR;

      CREATE TABLE IF NOT EXISTS pump_buy_events (
        token_ca VARCHAR NOT NULL,
        pump_id INTEGER NOT NULL,
        pump_start_time VARCHAR NOT NULL,
        seconds_before_pump DOUBLE NOT NULL,
        time VARCHAR NOT NULL,
        timestamp BIGINT NOT NULL,
        wallet VARCHAR NOT NULL,
        sol_amount DOUBLE NOT NULL,
        token_amount DOUBLE NOT NULL,
        price_sol DOUBLE NOT NULL,
        signature VARCHAR NOT NULL,
        slot BIGINT NOT NULL,
        pump_buy_flow_share DOUBLE NOT NULL,
        local_buy_flow_share DOUBLE NOT NULL,
        forward1 DOUBLE,
        forward3 DOUBLE,
        forward5 DOUBLE,
        forward10 DOUBLE,
        forward15 DOUBLE,
        forward30 DOUBLE,
        forward60 DOUBLE,
        max_forward15 DOUBLE,
        max_forward30 DOUBLE,
        lead_evidence_score DOUBLE NOT NULL,
        PRIMARY KEY (token_ca, signature, wallet)
      );

      CREATE TABLE IF NOT EXISTS wallet_token_summary (
        token_ca VARCHAR NOT NULL,
        rank INTEGER NOT NULL,
        wallet VARCHAR NOT NULL,
        lead_evidence_score DOUBLE NOT NULL,
        pumps_led INTEGER NOT NULL,
        pump_count INTEGER NOT NULL,
        median_seconds_before_pump DOUBLE,
        earliest_seconds_before_pump DOUBLE,
        avg_pump_buy_flow_share DOUBLE,
        max_pump_buy_flow_share DOUBLE,
        avg_local_buy_flow_share DOUBLE,
        max_local_buy_flow_share DOUBLE,
        trades BIGINT NOT NULL,
        buys BIGINT NOT NULL,
        sells BIGINT NOT NULL,
        buy_sol DOUBLE NOT NULL,
        sell_sol DOUBLE NOT NULL,
        net_buy_sol DOUBLE NOT NULL,
        median_trade_sol DOUBLE NOT NULL,
        first_buy_time VARCHAR NOT NULL,
        last_buy_time VARCHAR NOT NULL,
        pump_buys BIGINT NOT NULL,
        pump_buy_sol DOUBLE NOT NULL,
        pre_pump_buys BIGINT NOT NULL,
        pre_pump_buy_sol DOUBLE NOT NULL,
        lead1s_count BIGINT NOT NULL,
        lead3s_count BIGINT NOT NULL,
        lead5s_count BIGINT NOT NULL,
        lead10s_count BIGINT NOT NULL,
        lead15s_count BIGINT NOT NULL,
        lead1s_sol DOUBLE NOT NULL,
        lead3s_sol DOUBLE NOT NULL,
        lead5s_sol DOUBLE NOT NULL,
        lead10s_sol DOUBLE NOT NULL,
        lead15s_sol DOUBLE NOT NULL,
        early_pump_buys BIGINT NOT NULL,
        early_pump_buy_sol DOUBLE NOT NULL,
        breakout_lead_count BIGINT NOT NULL,
        breakout_lead_sol DOUBLE NOT NULL,
        forward1_median DOUBLE,
        forward3_median DOUBLE,
        forward5_median DOUBLE,
        forward10_median DOUBLE,
        forward15_median DOUBLE,
        forward30_median DOUBLE,
        forward60_median DOUBLE,
        max_forward15_median DOUBLE,
        max_forward30_median DOUBLE,
        forward15_positive_rate DOUBLE,
        forward30_positive_rate DOUBLE,
        forward60_positive_rate DOUBLE,
        mean_lead_evidence_score_per_pump DOUBLE,
        forward30_lift_vs_global_median DOUBLE,
        independent_pump_coverage DOUBLE NOT NULL,
        positive15_pump_rate DOUBLE,
        positive30_pump_rate DOUBLE,
        positive60_pump_rate DOUBLE,
        control_adjusted_forward5_median DOUBLE,
        control_adjusted_forward15_median DOUBLE,
        control_adjusted_forward30_median DOUBLE,
        control_adjusted_forward60_median DOUBLE,
        control_positive15_lift DOUBLE,
        control_positive30_lift DOUBLE,
        control_positive60_lift DOUBLE,
        control_adjusted30_pump_positive_count INTEGER NOT NULL,
        control_adjusted30_pump_rate DOUBLE,
        reliability_adjusted30_pump_rate DOUBLE,
        reliability_adjusted_excess_forward30_median DOUBLE,
        qualification_reason VARCHAR NOT NULL,
        PRIMARY KEY (token_ca, wallet)
      );

      CREATE TABLE IF NOT EXISTS debot_signals (
        fetched_at VARCHAR NOT NULL,
        observed_at_sec BIGINT NOT NULL,
        token_ca VARCHAR NOT NULL,
        symbol VARCHAR,
        name VARCHAR,
        presence VARCHAR NOT NULL,
        rank_1m INTEGER,
        rank_5m INTEGER,
        rank_delta_5m_minus_1m INTEGER,
        activity_score DOUBLE,
        pump_precursor_score DOUBLE,
        activity_score_1m DOUBLE,
        activity_score_5m DOUBLE,
        buy_pressure_1m DOUBLE,
        buy_pressure_5m DOUBLE,
        buy_pressure_delta DOUBLE,
        volume_acceleration DOUBLE,
        wallet_acceleration DOUBLE,
        volume_1m DOUBLE,
        volume_5m DOUBLE,
        unique_wallet_swaps_1m BIGINT,
        unique_wallet_swaps_5m BIGINT,
        buy_volume_1m DOUBLE,
        sell_volume_1m DOUBLE,
        buy_volume_5m DOUBLE,
        sell_volume_5m DOUBLE,
        liquidity DOUBLE,
        holders BIGINT,
        market_cap DOUBLE,
        fdv DOUBLE,
        price DOUBLE,
        price_change_1m DOUBLE,
        price_change_5m DOUBLE,
        smart_wallet_coverage_1m DOUBLE,
        smart_wallet_coverage_5m DOUBLE,
        token_tier VARCHAR,
        launchpad VARCHAR,
        heatmap_seen BOOLEAN NOT NULL,
        heatmap_occurrence_count INTEGER NOT NULL,
        heatmap_recency_sec BIGINT,
        heatmap_market_wallet_count BIGINT,
        heatmap_market_trade_volume DOUBLE,
        heatmap_market_wallet_acceleration DOUBLE,
        heatmap_market_volume_acceleration DOUBLE,
        signal_count BIGINT,
        signal_max_price_gain DOUBLE,
        signal_token_level VARCHAR,
        heatmap_to_signal_lag_sec BIGINT,
        is_trending BOOLEAN NOT NULL,
        is_pump_precursor_candidate BOOLEAN NOT NULL,
        candidate_reason VARCHAR,
        PRIMARY KEY (fetched_at, token_ca)
      );

      CREATE TABLE IF NOT EXISTS wallet_global_summary (
        wallet VARCHAR PRIMARY KEY,
        tokens_with_candidates BIGINT NOT NULL,
        pump_windows_led BIGINT NOT NULL,
        pre_pump_buy_sol DOUBLE NOT NULL,
        median_lead_seconds DOUBLE,
        median_excess_forward15 DOUBLE,
        median_excess_forward30 DOUBLE,
        median_excess_forward60 DOUBLE,
        median_pump_buy_flow_share DOUBLE,
        median_control_positive30_lift DOUBLE,
        avg_positive15_pump_rate DOUBLE,
        avg_positive30_pump_rate DOUBLE,
        avg_positive60_pump_rate DOUBLE,
        avg_reliability_adjusted30_pump_rate DOUBLE,
        avg_reliability_adjusted_excess_forward30 DOUBLE
      );

      -- Run provenance + ML-readiness columns. All ALTERs live here, after
      -- every CREATE, so fresh databases migrate in one pass.
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_started_at VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_completed_at VARCHAR;
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_status VARCHAR DEFAULT 'completed';
      ALTER TABLE tokens ADD COLUMN IF NOT EXISTS scan_error VARCHAR;
      ALTER TABLE pump_windows ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE control_baselines ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE wallet_pump_observations ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE pump_buy_events ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE wallet_token_summary ADD COLUMN IF NOT EXISTS run_id VARCHAR;
      ALTER TABLE wallet_token_summary ADD COLUMN IF NOT EXISTS control_backed_pumps INTEGER DEFAULT 0;
      ALTER TABLE wallet_token_summary ADD COLUMN IF NOT EXISTS predictive_qualified BOOLEAN DEFAULT FALSE;
      ALTER TABLE debot_signals ADD COLUMN IF NOT EXISTS liquidity_bucket VARCHAR;
      ALTER TABLE debot_signals ADD COLUMN IF NOT EXISTS market_cap_bucket VARCHAR;
    `);
  }

  /** Save one token atomically, replacing an earlier run for the same token. */
  async replaceToken(
    response: AnalysisResponse,
    logger: Logger,
    scanSource: string = 'cli',
    debotSignal: DeBotTrendingSignal | null = null,
    debotObservedAt: string | null = null,
  ): Promise<void> {
    const token = response.token;
    await logger.info(`Persisting ${token}: ${response.walletLeaders.length} wallet summaries, ${response.walletPumpObservations.length} observations`);

    await this.connection.run('BEGIN TRANSACTION');
    try {
      await this.connection.run('DELETE FROM pump_buy_events WHERE token_ca = $token', { token });
      await this.connection.run('DELETE FROM wallet_pump_observations WHERE token_ca = $token', { token });
      await this.connection.run('DELETE FROM control_baselines WHERE token_ca = $token', { token });
      await this.connection.run('DELETE FROM pump_windows WHERE token_ca = $token', { token });
      await this.connection.run('DELETE FROM wallet_token_summary WHERE token_ca = $token', { token });
      await this.connection.run('DELETE FROM tokens WHERE token_ca = $token', { token });

      const runId = response.runId ?? 'adhoc';
      await this.appendToken(response, scanSource, debotSignal, debotObservedAt);
      await this.appendPumpWindows(token, response.pumpWindows, runId);
      await this.appendControlBaselines(token, response.controlBaselines, runId);
      await this.appendObservations(token, response.walletPumpObservations, runId);
      await this.appendPumpBuyEvents(token, response.pumpBuyEvents, runId);
      await this.appendWalletTokenSummaries(token, response.walletLeaders, runId);

      await this.connection.run('COMMIT');
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }

    await this.refreshGlobalWalletSummary();
    await logger.info(`DuckDB updated for ${token}`);
  }

  /** Persist one complete DeBot snapshot without creating separate DB files. */
  async persistDeBotSnapshot(snapshot: DeBotTrendingSnapshot, logger: Logger): Promise<void> {
    await this.connection.run('BEGIN TRANSACTION');
    try {
      await this.connection.run('DELETE FROM debot_signals WHERE fetched_at = $fetchedAt', { fetchedAt: snapshot.fetchedAt });
      await this.appendDeBotSignals(snapshot);
      await this.connection.run('COMMIT');
    } catch (error) {
      await this.connection.run('ROLLBACK');
      throw error;
    }
    await logger.info(`DeBot snapshot persisted: ${snapshot.signals.length} normalized signals`);
  }

  /** Append normalized DeBot rows used for cross-token joins and research. */
  private async appendDeBotSignals(snapshot: DeBotTrendingSnapshot): Promise<void> {
    await this.insertRows('debot_signals', snapshot.signals, (row) => [
      snapshot.fetchedAt, snapshot.observedAtSec, row.address, row.symbol ?? null, row.name ?? null, row.presence,
      row.rank1m ?? null, row.rank5m ?? null, row.rankDelta5mMinus1m ?? null, row.activityScore ?? null,
      row.pumpPrecursorScore ?? null, row.activityScore1m ?? null, row.activityScore5m ?? null, row.buyPressure1m ?? null,
      row.buyPressure5m ?? null, row.buyPressureDelta1mMinus5m ?? null, row.volumeAcceleration ?? null, row.walletAcceleration ?? null,
      row.volume1m ?? null, row.volume5m ?? null, row.uniqueWalletSwaps1m == null ? null : BigInt(Math.trunc(row.uniqueWalletSwaps1m)),
      row.uniqueWalletSwaps5m == null ? null : BigInt(Math.trunc(row.uniqueWalletSwaps5m)), row.buyVolume1m ?? null, row.sellVolume1m ?? null,
      row.buyVolume5m ?? null, row.sellVolume5m ?? null, row.liquidity ?? null, row.holders == null ? null : BigInt(Math.trunc(row.holders)),
      row.marketCap ?? null, row.fdv ?? null, row.price ?? null, row.priceChange1m ?? null, row.priceChange5m ?? null,
      row.smartWalletCoverage1m ?? null, row.smartWalletCoverage5m ?? null, row.tokenTier ?? null, row.launchpad ?? null,
      row.heatmapSeen, row.heatmapOccurrenceCount, row.heatmapRecencySec == null ? null : BigInt(Math.trunc(row.heatmapRecencySec)),
      row.latestMarketWalletCount == null ? null : BigInt(Math.trunc(row.latestMarketWalletCount)), row.latestMarketTradeVolume ?? null,
      row.marketWalletAcceleration ?? null, row.marketVolumeAcceleration ?? null, row.signalCount == null ? null : BigInt(Math.trunc(row.signalCount)),
      row.signalMaxPriceGain ?? null, row.signalTokenLevel ?? null, row.heatmapToSignalLagSec == null ? null : BigInt(Math.trunc(row.heatmapToSignalLagSec)),
      row.isTrending, row.isPumpPrecursorCandidate, row.candidateReason ?? null,
      row.liquidityBucket ?? null, row.marketCapBucket ?? null,
    ]);
  }

  /** Refresh the cross-token materialized wallet summary from per-token rows. */
  private async refreshGlobalWalletSummary(): Promise<void> {
    await this.connection.run(`
      CREATE OR REPLACE TABLE wallet_global_summary AS
      SELECT
        wallet,
        COUNT(DISTINCT token_ca) AS tokens_with_candidates,
        SUM(pumps_led) AS pump_windows_led,
        SUM(pre_pump_buy_sol) AS pre_pump_buy_sol,
        median(median_seconds_before_pump) AS median_lead_seconds,
        median(control_adjusted_forward15_median) AS median_excess_forward15,
        median(control_adjusted_forward30_median) AS median_excess_forward30,
        median(control_adjusted_forward60_median) AS median_excess_forward60,
        median(avg_pump_buy_flow_share) AS median_pump_buy_flow_share,
        median(control_positive30_lift) AS median_control_positive30_lift,
        AVG(positive15_pump_rate) AS avg_positive15_pump_rate,
        AVG(positive30_pump_rate) AS avg_positive30_pump_rate,
        AVG(positive60_pump_rate) AS avg_positive60_pump_rate,
        AVG(reliability_adjusted30_pump_rate) AS avg_reliability_adjusted30_pump_rate,
        AVG(reliability_adjusted_excess_forward30_median) AS avg_reliability_adjusted_excess_forward30
      FROM wallet_token_summary
      GROUP BY wallet
    `);
  }

  private async appendToken(
    response: AnalysisResponse,
    scanSource: string,
    debotSignal: DeBotTrendingSignal | null,
    debotObservedAt: string | null,
  ): Promise<void> {
    const strongest = response.strongestPump;
    const activeWindowsJson = JSON.stringify(
      response.history.activeWindows.map((window) => ({
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        startTime: window.startTime,
        endTime: window.endTime,
        transactionCount: window.transactionCount,
      })),
    );
    const parseDropCountsJson = JSON.stringify(response.history.parseDropCounts);

    const columns = [
      'token_ca', 'analysis_version', 'scanned_at', 'history_pages',
      'transactions_returned', 'history_truncated', 'first_block_time', 'last_block_time',
      'detected_trades', 'market_buckets', 'pump_starts', 'pump_windows',
      'strongest_pump_start_time', 'strongest_pump_end_time', 'strongest_pump_return',
      'strongest_pump_buy_sol', 'scan_source', 'debot_observed_at', 'debot_rank_1m',
      'debot_rank_5m', 'debot_activity_score', 'debot_pump_precursor_score',
      'scan_strategy', 'lightweight_pages', 'lightweight_transactions_returned',
      'lightweight_first_block_time', 'lightweight_last_block_time', 'lightweight_truncated',
      'selected_active_hours', 'selected_active_windows', 'full_query_windows',
      'selected_active_hours_json', 'active_windows_json', 'parse_drop_counts_json',
      'selected_quiet_windows', 'quiet_windows_json', 'lightweight_cache_hit', 'full_cache_hits', 'full_cache_misses',
      'run_id', 'scan_started_at', 'scan_completed_at', 'scan_status', 'scan_error',
    ];

    await this.connection.run(
      `INSERT INTO tokens (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      [
        response.token,
        response.version,
        response.scannedAt,
        response.history.pages,
        response.history.transactionsReturned,
        response.history.truncated,
        response.history.firstBlockTime ?? null,
        response.history.lastBlockTime ?? null,
        response.market.detectedTrades,
        response.market.marketBuckets,
        response.market.pumpStarts,
        response.market.pumpWindows,
        strongest?.startTime ?? null,
        strongest?.endTime ?? null,
        strongest?.peakReturn ?? null,
        strongest?.buySol ?? null,
        scanSource,
        debotObservedAt,
        debotSignal?.rank1m ?? null,
        debotSignal?.rank5m ?? null,
        debotSignal?.activityScore ?? null,
        debotSignal?.pumpPrecursorScore ?? null,
        response.history.scanStrategy,
        response.history.lightweightPages,
        response.history.lightweightTransactionsReturned,
        response.history.lightweightFirstBlockTime ?? null,
        response.history.lightweightLastBlockTime ?? null,
        response.history.lightweightTruncated,
        0,
        response.history.activeWindows.length,
        response.history.fullQueryWindows,
        null,
        activeWindowsJson,
        parseDropCountsJson,
        response.history.quietWindows.length,
        JSON.stringify(response.history.quietWindows),
        response.history.lightweightCacheHit,
        response.history.fullCacheHits,
        response.history.fullCacheMisses,
        response.runId ?? 'adhoc',
        response.scanStartedAt ?? response.scannedAt,
        response.scanCompletedAt ?? response.scannedAt,
        'completed',
        null,
      ],
    );
  }

  private async appendPumpWindows(token: string, rows: PumpWindow[], runId: string): Promise<void> {
    await this.insertRows('pump_windows', rows, (row) => [
      token, row.id, row.startTimestamp, row.startTime, row.endTimestamp, row.endTime,
      row.startPriceSol, row.peakPriceSol, row.peakTimestamp, row.peakReturn,
      row.max15sReturn, row.max30sReturn, row.netBuySol, row.buySol, row.sellSol,
      row.buyCount, row.sellCount,
      runId,
    ]);
  }

  private async appendControlBaselines(token: string, rows: ControlBaseline[], runId: string): Promise<void> {
    await this.insertRows('control_baselines', rows, (row) => [
      token, row.pumpId, row.pumpStartTime, row.windowStartTime, row.windowEndTime,
      row.buyCount, row.buySol, row.availableBuyCount, row.availableBuySol,
      row.forward5Median ?? null, row.forward15Median ?? null, row.forward30Median ?? null, row.forward60Median ?? null,
      row.positive5Rate ?? null, row.positive15Rate ?? null, row.positive30Rate ?? null, row.positive60Rate ?? null,
      runId,
    ]);
  }

  private async appendObservations(token: string, rows: WalletPumpObservation[], runId: string): Promise<void> {
    await this.insertRows('wallet_pump_observations', rows, (row) => [
      // run_id is ALTER-appended physically last; keep it last here too.
      token, row.wallet, row.pumpId, row.pumpStartTime, row.pumpEndTime, row.pumpReturn, row.pumpBuySol,
      row.buyCount, row.prePumpBuyCount, row.prePumpBuySol, row.earlyPumpBuyCount, row.earlyPumpBuySol, row.controlSufficient, row.controlShortfallReason ?? null, row.medianSecondsBeforePump ?? null,
      row.p25SecondsBeforePump ?? null, row.p75SecondsBeforePump ?? null, row.earliestSecondsBeforePump ?? null,
      row.lead1sCount, row.lead3sCount, row.lead5sCount, row.lead10sCount, row.lead15sCount,
      row.lead1sSol, row.lead3sSol, row.lead5sSol, row.lead10sSol, row.lead15sSol,
      row.medianPumpBuyFlowShare ?? null, row.maxPumpBuyFlowShare ?? null,
      row.medianLocalBuyFlowShare ?? null, row.maxLocalBuyFlowShare ?? null,
      row.forward1Median ?? null, row.forward3Median ?? null, row.forward5Median ?? null, row.forward10Median ?? null,
      row.forward15Median ?? null, row.forward30Median ?? null, row.forward60Median ?? null,
      row.maxForward15Median ?? null, row.maxForward30Median ?? null,
      row.positive15Rate ?? null, row.positive30Rate ?? null, row.positive60Rate ?? null, row.leadEvidenceScore,
      row.controlBuyCount, row.controlBuySol, row.controlAvailableBuyCount, row.controlAvailableBuySol,
      row.controlForward5Median ?? null, row.controlForward15Median ?? null, row.controlForward30Median ?? null, row.controlForward60Median ?? null,
      row.controlPositive15Rate ?? null, row.controlPositive30Rate ?? null, row.controlPositive60Rate ?? null,
      row.excessForward5Median ?? null, row.excessForward15Median ?? null, row.excessForward30Median ?? null, row.excessForward60Median ?? null,
      row.positive15Lift ?? null, row.positive30Lift ?? null, row.positive60Lift ?? null,
      runId,
    ]);
  }

  private async appendPumpBuyEvents(token: string, rows: PumpBuyEventOutput[], runId: string): Promise<void> {
    await this.insertRows('pump_buy_events', rows, (row) => [
      token, row.pumpId, row.pumpStartTime, row.secondsBeforePump, row.time, row.timestamp, row.wallet,
      row.solAmount, row.tokenAmount, row.priceSol, row.signature, row.slot, row.pumpBuyFlowShare, row.localBuyFlowShare,
      row.forward1 ?? null, row.forward3 ?? null, row.forward5 ?? null, row.forward10 ?? null,
      row.forward15 ?? null, row.forward30 ?? null, row.forward60 ?? null, row.maxForward15 ?? null, row.maxForward30 ?? null,
      row.leadEvidenceScore,
      runId,
    ]);
  }

  private async appendWalletTokenSummaries(token: string, rows: WalletLeader[], runId: string): Promise<void> {
    // ALTER-appended columns (run_id, control_backed_pumps,
    // predictive_qualified) are physically last; keep them last here too.
    await this.insertRows('wallet_token_summary', rows, (row) => [
      token, row.rank, row.wallet, row.leadEvidenceScore, row.pumpsLed, row.pumpCount,
      row.medianSecondsBeforePump ?? null, row.earliestSecondsBeforePump ?? null,
      row.avgPumpBuyFlowShare ?? null, row.maxPumpBuyFlowShare ?? null, row.avgLocalBuyFlowShare ?? null, row.maxLocalBuyFlowShare ?? null,
      row.trades, row.buys, row.sells, row.buySol, row.sellSol, row.netBuySol, row.medianTradeSol, row.firstBuyTime, row.lastBuyTime,
      row.pumpBuys, row.pumpBuySol, row.prePumpBuys, row.prePumpBuySol,
      row.lead1sCount, row.lead3sCount, row.lead5sCount, row.lead10sCount, row.lead15sCount,
      row.lead1sSol, row.lead3sSol, row.lead5sSol, row.lead10sSol, row.lead15sSol,
      row.earlyPumpBuys, row.earlyPumpBuySol, row.breakoutLeadCount, row.breakoutLeadSol,
      row.forward1Median ?? null, row.forward3Median ?? null, row.forward5Median ?? null, row.forward10Median ?? null,
      row.forward15Median ?? null, row.forward30Median ?? null, row.forward60Median ?? null,
      row.maxForward15Median ?? null, row.maxForward30Median ?? null,
      row.forward15PositiveRate ?? null, row.forward30PositiveRate ?? null, row.forward60PositiveRate ?? null,
      row.meanLeadEvidenceScorePerPump ?? null, row.forward30LiftVsGlobalMedian ?? null, row.independentPumpCoverage,
      row.positive15PumpRate ?? null, row.positive30PumpRate ?? null, row.positive60PumpRate ?? null,
      row.controlAdjustedForward5Median ?? null, row.controlAdjustedForward15Median ?? null,
      row.controlAdjustedForward30Median ?? null, row.controlAdjustedForward60Median ?? null,
      row.controlPositive15Lift ?? null, row.controlPositive30Lift ?? null, row.controlPositive60Lift ?? null,
      row.controlAdjusted30PumpPositiveCount, row.controlAdjusted30PumpRate ?? null,
      row.reliabilityAdjusted30PumpRate ?? null, row.reliabilityAdjustedExcessForward30Median ?? null,
      row.qualificationReason,
      runId,
      row.controlBackedPumps,
      row.predictiveQualified,
    ]);
  }

  /** Append normalized rows with parameterized SQL in small batches. */
  private async insertRows<T>(
    table: string,
    rows: T[],
    valuesForRow: (row: T) => readonly unknown[],
  ): Promise<void> {
    if (!rows.length) return;

    const valueRows = rows.map(valuesForRow);

    const first = valueRows[0];
    if (!first || first.length === 0) return;

    const columnCount = first.length;
    for (const row of valueRows) {
      if (row.length !== columnCount) {
        throw new Error(`Inconsistent column count while inserting into ${table}`);
      }
    }

    // Keep placeholder counts comfortably below DuckDB parameter limits while
    // still reducing parse/prepare overhead for multi-token batches.
    const batchSize = 50;
    const tableSql = quoteIdentifier(table);

    for (let offset = 0; offset < valueRows.length; offset += batchSize) {
      const batch = valueRows.slice(offset, offset + batchSize);
      const placeholders = batch
        .map((_, rowIndex) => {
          const base = rowIndex * columnCount;
          return `(${Array.from({ length: columnCount }, (_, colIndex) => `$${base + colIndex + 1}`).join(', ')})`;
        })
        .join(', ');
      const values = batch.flatMap((row) => row.map(sqlValue));
      await this.connection.run(`INSERT INTO ${tableSql} VALUES ${placeholders}`, values);
    }
  }

  /** Execute one analytical query and return plain JS row objects. */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql);
    return reader.getRowObjects() as T[];
  }

  /** Export a SELECT query directly through DuckDB's CSV writer. */
  async exportCsv(query: string, outputPath: string): Promise<void> {
    const parent = outputPath.slice(0, outputPath.lastIndexOf('/'));
    if (parent) await mkdir(parent, { recursive: true });
    const safePath = outputPath.replaceAll("'", "''");
    await this.connection.run(`COPY (${query}) TO '${safePath}' (HEADER, DELIMITER ',')`);
  }

  /**
   * Record a failed token scan. Never overwrites a previous successful
   * analysis: absence must not be mistaken for a negative example, and a past
   * success must not be clobbered by a later budget skip.
   */
  async recordFailure(
    args: {
      token: string;
      runId: string;
      scanSource: string;
      scanStartedAt: string;
      scanStatus: TokenScanStatus;
      error: string;
    },
    logger: Logger,
  ): Promise<void> {
    const safe = args.token.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
    if (safe !== args.token) throw new Error(`Unsafe token for failure record: ${args.token}`);
    const reader = await this.connection.runAndReadAll(
      `SELECT token_ca FROM tokens WHERE token_ca = '${safe}' LIMIT 1`,
    );
    if (reader.getRowObjects().length > 0) {
      await logger.info(`Token ${args.token}: keeping previous successful analysis; failure recorded to response.json only`);
      return;
    }
    const scannedAt = new Date().toISOString();
    const columns = [
      'token_ca', 'analysis_version', 'scanned_at', 'history_pages',
      'transactions_returned', 'history_truncated', 'detected_trades',
      'market_buckets', 'pump_starts', 'pump_windows', 'scan_source',
      'run_id', 'scan_started_at', 'scan_completed_at', 'scan_status', 'scan_error',
    ];
    await logger.info(`Token ${args.token}: recording scan failure (${args.scanStatus})`);
    await this.connection.run(
      `INSERT INTO tokens (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      [
        args.token, 11, scannedAt, 0,
        0, false, 0,
        0, 0, 0, args.scanSource,
        args.runId, args.scanStartedAt, scannedAt, args.scanStatus, args.error.slice(0, 2000),
      ].map(sqlValue),
    );
  }

  /** Close the DuckDB connection using the method exposed by the current runtime. */
  close(): void {
    const connection = this.connection as unknown as {
      closeSync?: () => void;
      disconnectSync?: () => void;
    };

    if (typeof connection.closeSync === 'function') {
      connection.closeSync();
      return;
    }

    if (typeof connection.disconnectSync === 'function') {
      connection.disconnectSync();
      return;
    }

    throw new Error('DuckDB connection does not expose closeSync() or disconnectSync()');
  }
}


/** Persist one analyzed token using the transactional replacement path. */
export async function persistToken(
  db: ResearchDb,
  response: AnalysisResponse,
  logger: Logger,
  scanSource = 'cli',
  debotSignal: DeBotTrendingSignal | null = null,
  debotObservedAt: string | null = null,
): Promise<void> {
  await db.replaceToken(response, logger, scanSource, debotSignal, debotObservedAt);
}

export type TokenScanStatus =
  | 'completed'
  | 'budget_exceeded'
  | 'light_history_too_dense'
  | 'error';

/**
 * Record a failed token scan in DuckDB so budget-skipped tokens are visible
 * as explicit scan_status rows instead of silently absent. Never overwrites a
 * previous successful analysis: absence must not be mistaken for a negative
 * example, and a past success must not be clobbered by a later budget skip.
 */
export async function recordTokenFailure(
  db: ResearchDb,
  logger: Logger,
  args: {
    token: string;
    runId: string;
    scanSource: string;
    scanStartedAt: string;
    scanStatus: TokenScanStatus;
    error: string;
  },
): Promise<void> {
  await db.recordFailure(args, logger);
}

/** Export a global analytical table/query for pandas, Polars, or Excel. */
export async function exportGlobalCsv(db: ResearchDb, query: string, outputPath: string): Promise<void> {
  await db.exportCsv(query, outputPath);
}
