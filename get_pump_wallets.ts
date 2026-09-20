import { readFile, mkdir, stat } from 'node:fs/promises';
import {
  analyzeToken,
  selectStrongestPump,
  type AnalysisResponse,
} from './src/analyzer';
import { loadConfig, type Config } from './src/config';
import { exportGlobalCsv, persistToken, ResearchDb } from './src/duckdb';
import { fetchTransactions } from './src/helius';
import { Logger } from './src/logger';
import { objectsToCsv } from './src/csv';
import {
  DeBotClient,
  type DeBotTrendingSignal,
  type DeBotTrendingSnapshot,
  type DeBotPumpCandidateDiagnostics,
} from './src/debot_client';
import { DeBotFileLogger } from './src/debot_logger';

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type TokenSource = 'cli' | 'debot' | 'cli+debot';

type IntegratedResponse = AnalysisResponse & {
  integration: {
    scanSource: TokenSource;
    debotObservedAt: string | null;
    debotSignal: DeBotTrendingSignal | null;
  };
};

/** Print CLI usage without exposing configuration values. */
function printHelp(): void {
  console.log(`
Solana multi-token pump-wallet research scanner with DeBot discovery

Usage:
  bun run get_pump_wallets.ts --token <TOKEN_CA>
  bun run get_pump_wallets.ts --token <TOKEN_CA_1> --token <TOKEN_CA_2>
  bun run get_pump_wallets.ts --token ./tokenlist.txt
  bun run get_pump_wallets.ts --token ./tokenlist.txt --token <TOKEN_CA>

Options:
  --token <CA|FILE>      Token mint, comma-separated mints, or a token-list file.
                         Repeatable. A readable file path is loaded automatically.
  --tokens-file <FILE>  Backward-compatible alias for a newline-delimited token list.
  -h, --help             Show this help.

Token-list format:
  One Solana mint per line. Blank lines and # comments are ignored.

Behavior:
  - Explicit --token values are always scanned by Helius.
  - Helius token scans are intentionally serial: one token is held in memory at a time.
  - When DEBOT_ENABLED=true and DEBOT_SCAN_CANDIDATES=true, DeBot pump-precursor
    candidates are added to the Helius token set (deduplicated).
  - Set DEBOT_SCAN_CANDIDATES=false to analyze only explicit CLI tokens.

Per-token output:
  ./data/pump_wallet_tnxs/token-{CA}/response.json
  ./data/pump_wallet_tnxs/token-{CA}/wallet-leader.csv

Global DuckDB:
  ./data/pump_wallets.duckdb

DeBot logs (exactly two files):
  ./logs/debot/signals.json
  ./logs/debot/signals.csv

All non-CLI runtime/strategy values are loaded from .env.
`);
}

/** Return true when a CLI --token value points to a readable regular file. */
async function isReadableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Parse and validate a newline-delimited Solana token list. */
function parseTokenList(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

/** Expand a single --token value into one or more token mint addresses. */
async function expandTokenArgument(value: string): Promise<string[]> {
  if (await isReadableFile(value)) {
    return parseTokenList(await readFile(value, 'utf8'));
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse repeated --token values, including the requested --token ./tokenlist.txt form. */
async function parseCli(): Promise<string[]> {
  const args = Bun.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const tokens: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--token' || arg === '--tokens-file') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for ${arg}`);
      }
      tokens.push(...await expandTokenArgument(value));
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  const unique = [...new Set(tokens)];
  for (const token of unique) {
    if (!SOLANA_MINT_RE.test(token)) {
      throw new Error(`Invalid Solana mint address: ${token}`);
    }
  }

  return unique;
}

function tokenDir(config: Config, token: string): string {
  return `${config.tokenOutputRoot}/token-${token}`;
}

/**
 * Write the independent per-token research artifacts. The JSON adds the
 * integration metadata while wallet-leader.csv stays focused on Helius data.
 */
async function writeTokenResponse(
  config: Config,
  response: IntegratedResponse,
): Promise<void> {
  const dir = tokenDir(config, response.token);
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/response.json`, JSON.stringify(response, null, 2));
  await Bun.write(
    `${dir}/wallet-leader.csv`,
    objectsToCsv(response.walletLeaders as unknown as Array<Record<string, unknown>>),
  );
}

/** Run Helius analysis for one token; DuckDB persistence stays serial. */
async function analyzeOne(
  config: Config,
  token: string,
  logger: Logger,
  source: TokenSource,
  debotObservedAt: string | null,
  debotSignal: DeBotTrendingSignal | null,
): Promise<IntegratedResponse> {
  await logger.info(`Token ${token}: starting historical scan | source=${source}`);

  // Helius parses pages into compact trades, so the parser must receive the
  // current mint explicitly. This avoids mutable token state and prevents a
  // token-address filter from silently dropping every trade.
  const fetched = await fetchTransactions(token, config, logger);
  await logger.info(`Token ${token}: Helius returned ${fetched.transactionsReturned} transactions; retained ${fetched.trades.length} compact trades`);
  const analysis = analyzeToken(config, token, fetched);
  const response: IntegratedResponse = {
    ...analysis,
    integration: {
      scanSource: source,
      debotObservedAt,
      debotSignal,
    },
  };
  await writeTokenResponse(config, response);
  await logger.info(
    `Token ${token}: trades=${response.market.detectedTrades} pumps=${response.market.pumpWindows} wallets=${response.walletLeaders.length}`,
  );
  return response;
}

/** Export the global multi-token DuckDB research views. */
async function exportGlobalViews(db: ResearchDb, config: Config): Promise<void> {
  await exportGlobalCsv(
    db,
    `SELECT * FROM tokens ORDER BY pump_windows DESC, detected_trades DESC, token_ca`,
    `${config.globalExportDir}/tokens.csv`,
  );
  await exportGlobalCsv(
    db,
    `SELECT * FROM pump_windows ORDER BY start_timestamp, token_ca, pump_id`,
    `${config.globalExportDir}/pump-windows.csv`,
  );
  await exportGlobalCsv(
    db,
    `SELECT * FROM wallet_pump_observations ORDER BY token_ca, pump_id, lead_evidence_score DESC, wallet`,
    `${config.globalExportDir}/wallet-pump-observations.csv`,
  );
  await exportGlobalCsv(
    db,
    `SELECT * FROM wallet_token_summary ORDER BY token_ca, reliability_adjusted_excess_forward30_median DESC NULLS LAST, pumps_led DESC, wallet`,
    `${config.globalExportDir}/wallet-token-summary.csv`,
  );
  await exportGlobalCsv(
    db,
    `SELECT * FROM wallet_global_summary ORDER BY tokens_with_candidates DESC, pump_windows_led DESC, median_excess_forward30 DESC NULLS LAST, wallet`,
    `${config.globalExportDir}/wallet-global-summary.csv`,
  );
  await exportGlobalCsv(
    db,
    `SELECT * FROM debot_signals ORDER BY observed_at_sec DESC, pump_precursor_score DESC NULLS LAST, token_ca`,
    `${config.globalExportDir}/debot-signals.csv`,
  );
}

/** Print a compact summary for one token after it has been analyzed. */
function printResponseSummary(response: IntegratedResponse, config: Config): void {
  const strongest = selectStrongestPump(response.pumpWindows);
  console.log(`\nToken  : ${response.token}`);
  console.log(`Source : ${response.integration.scanSource}`);
  console.log(`Light : ${response.history.lightweightTransactionsReturned} signatures | ${response.history.activeWindows.length} active + ${response.history.quietWindows.length} quiet windows`);
  console.log(`Full  : ${response.history.transactionsReturned} tx | ${response.history.fullQueryWindows} query windows | cache ${response.history.fullCacheHits}/${response.history.fullCacheMisses}`);
  console.log(`Trades: ${response.market.detectedTrades}`);
  console.log(`Pumps : ${response.market.pumpWindows}`);
  console.log(`Wallets: ${response.walletLeaders.length}`);
  console.log(`Light cache: ${response.history.lightweightCacheHit ? 'hit' : 'miss'}`);
  console.log(`Parse : acceptedTx=${response.history.parseDropCounts.accepted_transactions} acceptedTrades=${response.history.parseDropCounts.accepted_trades} drops=${Object.entries(response.history.parseDropCounts).filter(([key]) => key !== 'accepted_transactions' && key !== 'accepted_trades').reduce((sum, [, value]) => sum + value, 0)}`);
  console.log(`Output : ${tokenDir(config, response.token)}`);

  if (response.integration.debotSignal) {
    const signal = response.integration.debotSignal;
    console.log(
      `DeBot  : pump=${signal.pumpPrecursorScore?.toFixed(2) ?? 'n/a'} activity=${signal.activityScore?.toFixed(2) ?? 'n/a'} rank=${signal.rank1m ?? '-'}/${signal.rank5m ?? '-'}`,
    );
  }

  if (strongest) {
    console.log(`Strongest pump: ${strongest.startTime} -> ${strongest.endTime}`);
    console.log(`Peak return   : ${(strongest.peakReturn * 100).toFixed(2)}%`);
    console.log(`Pump buy SOL  : ${strongest.buySol.toFixed(2)}`);
  }

  const top = response.walletLeaders.slice(0, Math.min(config.topWallets, response.walletLeaders.length));
  if (top.length) {
    console.log('rank | wallet                                           | rel30   | pumps | leadSec | coverage');
    console.log('-----+--------------------------------------------------+---------+-------+---------+---------');
    for (const leader of top) {
      const rel = leader.reliabilityAdjustedExcessForward30Median === null
        ? '    n/a'
        : `${(leader.reliabilityAdjustedExcessForward30Median * 100).toFixed(2)}%`.padStart(7);
      const lead = leader.medianSecondsBeforePump === null
        ? '    n/a'
        : leader.medianSecondsBeforePump.toFixed(1).padStart(7);
      console.log(
        `${String(leader.rank).padStart(4)} | ${leader.wallet.padEnd(48)} | ${rel} | ${String(leader.pumpsLed).padStart(5)} | ${lead} | ${(leader.independentPumpCoverage * 100).toFixed(1).padStart(7)}%`,
      );
    }
  }
}

/** Fetch and log the current DeBot snapshot before Helius token analysis. */
async function discoverWithDeBot(
  config: Config,
  rootLogger: Logger,
): Promise<{ snapshot: DeBotTrendingSnapshot; candidates: DeBotTrendingSignal[] }> {
  const client = new DeBotClient(config.debot);
  const snapshot = await client.fetchTrendingSignals({ limit: config.debot.rankLimit });
  const annotated = client.annotateCandidates(snapshot);
  const pumpCandidates = client.getPumpPrecursorCandidates(annotated);
  const activityLeaders = client.getActivityLeaders(annotated);
  const candidateDiagnostics: DeBotPumpCandidateDiagnostics = client.getPumpCandidateDiagnostics(annotated);

  const fileLogger = new DeBotFileLogger({ directory: `${config.logDir}/debot` });
  await fileLogger.logSnapshot(annotated);

  await rootLogger.info(
    `DeBot snapshot: 1m=${snapshot.oneMinute.data.length} 5m=${snapshot.fiveMinute.data.length} ` +
    `heatmapBuckets=${snapshot.heatmap.data.heatmap.length} merged=${snapshot.signals.length} ` +
    `activityLeaders=${activityLeaders.length} pumpCandidates=${pumpCandidates.length}`,
  );
  await rootLogger.info(
    `DeBot candidate gates: 1m=${candidateDiagnostics.require1mPassed}/${candidateDiagnostics.totalSignals} ` +
    `presence=${candidateDiagnostics.presencePassed} scored=${candidateDiagnostics.scored} ` +
    `evidence=${candidateDiagnostics.evidencePassed} volume=${candidateDiagnostics.volumePassed} ` +
    `positive=${candidateDiagnostics.positiveEvidencePassed} heatmap=${candidateDiagnostics.heatmapPassed} ` +
    `final=${candidateDiagnostics.finalCandidates}`,
  );

  console.log(`\nDeBot snapshot: ${snapshot.fetchedAt}`);
  console.log(`DeBot activity leaders: ${activityLeaders.length}`);
  console.log(`DeBot pump candidates : ${pumpCandidates.length}`);
  console.log(
    `DeBot gates           : 1m=${candidateDiagnostics.require1mPassed}/${candidateDiagnostics.totalSignals} ` +
    `presence=${candidateDiagnostics.presencePassed} scored=${candidateDiagnostics.scored} ` +
    `evidence=${candidateDiagnostics.evidencePassed} volume=${candidateDiagnostics.volumePassed} ` +
    `positive=${candidateDiagnostics.positiveEvidencePassed} final=${candidateDiagnostics.finalCandidates}`,
  );
  if (pumpCandidates.length) {
    for (const [index, candidate] of pumpCandidates.entries()) {
      console.log(
        `  ${String(index + 1).padStart(2)} | ${(candidate.symbol ?? '?').padEnd(12)} | ${candidate.address} | ` +
        `pump=${candidate.pumpPrecursorScore?.toFixed(2) ?? 'n/a'} | ` +
        `buy=${candidate.buyPressure1m === null ? 'n/a' : `${(candidate.buyPressure1m * 100).toFixed(1)}%`} | ` +
        `vol=${candidate.volumeAcceleration === null ? 'n/a' : `${candidate.volumeAcceleration.toFixed(2)}x`} | ` +
        `wallet=${candidate.walletAcceleration === null ? 'n/a' : `${candidate.walletAcceleration.toFixed(2)}x`}`,
      );
    }
  }

  return { snapshot: annotated, candidates: pumpCandidates };
}

/** Main integrated workflow: DeBot discovery → Helius → DuckDB. */
async function main(): Promise<void> {
  const config = loadConfig();
  const cliTokens = await parseCli();
  const rootLogger = await Logger.create(config.logDir);
  await rootLogger.info(`Starting integrated scan | explicit tokens=${cliTokens.length}`);
  await rootLogger.info(
    `DeBot config: enabled=${config.debotEnabled} scanCandidates=${config.debotScanCandidates} ` +
    `minScore=${config.debot.minPumpPrecursorScore} minEvidence=${config.debot.minPumpPrecursorEvidence} ` +
    `minPositive=${config.debot.minPumpPrecursorPositiveEvidence} minVolume=${config.debot.minVolumeAcceleration}`,
  );

  const db = await ResearchDb.open(config, rootLogger);
  try {
    let debotSnapshot: DeBotTrendingSnapshot | null = null;
    let debotCandidates: DeBotTrendingSignal[] = [];

    if (config.debotEnabled) {
      try {
        const discovered = await discoverWithDeBot(config, rootLogger);
        debotSnapshot = discovered.snapshot;
        debotCandidates = discovered.candidates;
        await db.persistDeBotSnapshot(debotSnapshot, rootLogger);
      } catch (error) {
        await rootLogger.error('DeBot discovery or DuckDB persistence failed; continuing with explicit CLI tokens', error);
        if (config.debotScanCandidates && cliTokens.length === 0) throw error;
      }
    }

    const sources = new Map<string, TokenSource>();
    for (const token of cliTokens) sources.set(token, 'cli');

    if (config.debotEnabled && config.debotScanCandidates) {
      for (const signal of debotCandidates) {
        if (!sources.has(signal.address)) sources.set(signal.address, 'debot');
        else sources.set(signal.address, 'cli+debot');
      }
    }

    if (sources.size === 0) {
      if (config.debotEnabled && config.debotScanCandidates && debotSnapshot) {
        throw new Error(
          `DeBot is enabled and candidate scanning is enabled, but 0 pump candidates passed the current filters ` +
          `(score>=${config.debot.minPumpPrecursorScore}, evidence>=${config.debot.minPumpPrecursorEvidence}, ` +
          `positiveEvidence>=${config.debot.minPumpPrecursorPositiveEvidence}, volume>${config.debot.minVolumeAcceleration}). ` +
          `Use --token <CA|FILE> for explicit analysis or adjust the DeBot candidate thresholds.`,
        );
      }
      throw new Error(
        'No tokens to analyze. Provide --token <CA|FILE>, or enable DEBOT_ENABLED=true and DEBOT_SCAN_CANDIDATES=true.',
      );
    }

    const tokens = [...sources.keys()];
    console.log(`\nTokens to analyze : ${tokens.length}`);
    console.log(`Explicit tokens   : ${cliTokens.length}`);
    console.log(`DeBot candidates  : ${debotCandidates.length}`);
    console.log('Helius token mode  : serial (1 token at a time)');

    // Deliberately process tokens serially. A full Helius page is parsed and
    // discarded immediately, and only the compact Trade[] survives. This keeps
    // peak RAM bounded by one token instead of N concurrent full histories.
    let success = 0;
    for (const [index, token] of tokens.entries()) {
      const logger = rootLogger.child(token);
      console.log(`\n[${index + 1}/${tokens.length}] Analyzing ${token}`);
      try {
        const debotSignal = debotSnapshot?.signals.find((signal) => signal.address === token) ?? null;
        const source = sources.get(token)!;
        const result = await analyzeOne(
          config,
          token,
          logger,
          source,
          debotSnapshot?.fetchedAt ?? null,
          debotSignal,
        );

        await persistToken(
          db,
          result,
          logger,
          result.integration.scanSource,
          result.integration.debotSignal,
          result.integration.debotObservedAt,
        );
        success += 1;
        printResponseSummary(result, config);

        const memory = process.memoryUsage();
        await rootLogger.info(
          `Token ${token}: complete | rss=${Math.round(memory.rss / 1024 / 1024)}MB heap=${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
        );
      } catch (error) {
        await logger.error(`Token ${token}: scan failed`, error);
        const dir = tokenDir(config, token);
        await mkdir(dir, { recursive: true });
        await Bun.write(
          `${dir}/response.json`,
          JSON.stringify({
            version: 11,
            token,
            status: 'error',
            scannedAt: new Date().toISOString(),
            integration: {
              scanSource: sources.get(token) ?? 'cli',
              debotObservedAt: debotSnapshot?.fetchedAt ?? null,
            },
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        );
      }
    }

    await exportGlobalViews(db, config);
    await rootLogger.info(`Finished: ${success}/${tokens.length} token(s) persisted successfully`);

    console.log(`\nDuckDB    : ${config.duckdbPath}`);
    console.log(`Global CSV: ${config.globalExportDir}`);
    console.log(`DeBot logs: ${config.logDir}/debot/signals.json`);
    console.log(`            ${config.logDir}/debot/signals.csv`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
