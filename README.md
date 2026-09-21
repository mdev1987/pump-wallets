# Solana Pump Wallet Research — Final v11

Memory-safe, multi-token Solana pump-window and wallet-leader research pipeline.

## Pipeline

```text
DeBot 1m + 5m + heatmap  (+ optional Top PnL candidate file)
        ↓
pump-precursor candidates
        ↓
one token at a time
        ↓
Helius signatures-only history (density-guarded)
        ↓
1-minute activity buckets + 1-second fine buckets
        ↓
busiest windows + quiet pre-spike reconnaissance
        ↓
union overlapping fetch ranges
        ↓
recursively split dense ranges (fail-closed budget)
        ↓
Helius full transactions only for selected ranges
        ↓
parse each page immediately / discard raw page
        ↓
adaptive fast + sustained pump detection
        ↓
distribution tops excluded from leadership evidence
        ↓
wallet × pump observations (entry evidence vs outcome labels)
        ↓
DuckDB + per-token JSON/CSV (+ candidate match snapshots)
```

## Memory and performance

Tokens are strictly serial. Full Helius pages are parsed immediately and never retained. The lightweight stage retains only timestamp counters. Dense full-fetch ranges are split before retrieval; there is no first-N-page truncation.

Light and full ranges are cached on disk so repeat runs can reuse historical work. Full ranges are merged on **actual overlap** before splitting, preventing double-fetching of intersecting windows without unnecessarily joining merely-nearby windows.

## CLI

```bash
bun run get_pump_wallets.ts -h

bun run get_pump_wallets.ts --token TOKEN_CA

bun run get_pump_wallets.ts --token ./tokens.txt

bun run get_pump_wallets.ts --token TOKEN_A --token TOKEN_B --token ./tokens.txt

bun run get_pump_wallets.ts --candidate-file ./top-pnl.csv --token TOKEN_CA
```

With no explicit tokens, DeBot candidates are used when enabled. Explicit tokens are always analyzed. Explicit `--token` scans skip DeBot discovery requests entirely.

Top PnL CSV/JSON (`--candidate-file`, format in `top-pnl.candidates.example.csv`) adds candidate tokens to the scan set. PnL fields are stored as discovery metadata only — they never enter the wallet score. Each candidate is classified afterwards as `matched_leader` / `observed_non_leader` / `not_observed` and exported to `candidate-wallet-analysis.csv`.

## Per-token output

```text
data/pump_wallet_tnxs/token-{CA}/
├── response.json
└── wallet-leader.csv
```

## Global research store

```text
data/pump_wallets.duckdb
```

Key tables:

```text
tokens                  (run_id, scan_started_at/completed_at, scan_status)
pump_windows            (run_id, is_distribution flagged in JSON)
control_baselines       (run_id)
wallet_pump_observations(run_id, entry_evidence_score)
pump_buy_events         (run_id, entry_evidence_score)
wallet_token_summary    (run_id, pre_pump_pumps, control_backed_pumps,
                         predictive_qualified, entry_evidence_score)
wallet_global_summary
debot_signals           (liquidity_bucket, market_cap_bucket)
candidate_wallets       (Top PnL rows + match snapshots)
```

Every row carries `run_id` so multi-run datasets never mix scan times implicitly — except `wallet_global_summary`, which is a latest-state compatibility view rebuilt from all current per-token rows (no `run_id`; do not read it as one coherent observation period). Failed scans are recorded in `tokens` with an explicit `scan_status` (`completed` | `budget_exceeded` | `light_history_too_dense` | `error`) and never overwrite a previous success.

`prospective-watchlist.csv` ranks wallets on entry-time cross-token evidence only (pre-pump windows/buys/SOL, backed windows). `wallet-global-summary.csv` is ordered retrospectively and must never be read as a prospective leaderboard.

Global CSV exports are written under `data/pump_wallet_exports/`, including `candidate-wallet-analysis.csv` (candidates joined to cross-token evidence) and `copy-watchlist.csv` (wallets seen on 2+ tokens, the paper-trading watchlist).

## DeBot logs

Exactly two files are kept:

```text
logs/debot/signals.json
logs/debot/signals.csv
```

## Helius staged scan

### Stage 1

`getTransactionsForAddress` is queried with `transactionDetails=signatures` and a 1,000-record page size. Only 1-minute and fine activity counters are retained.

### Stage 2

The planner selects the busiest regions plus a small number of low-activity pre-spike windows. Overlapping ranges are unioned, then dense ranges are recursively split using the lightweight fine-grained counts.

Every full transaction page is parsed immediately, and only compact trades survive.

## Pump detection

Two paths are used:

- **fast**: short vertical move + confirmation + buy flow + transaction pace + buy pressure
- **sustained**: slower multi-minute grind + confirmation + buy flow + pace + pressure

Pump starts are clustered over `PUMP_CLUSTER_SEC`. Wallet evidence includes a 120-second pre-pump window and separate early-pump observations.

Matched control observations below `MIN_CONTROL_BUYS_PER_PUMP` are **flagged, not discarded**.

## Entry evidence vs outcome labels

Wallet ranking uses **entry-time evidence only**: timing, size, and buy-flow shares computed solely from buys visible at or before each trade timestamp. Forward returns and control-adjusted outcomes are stored as evaluation labels, never ranking inputs — ranking on them would leak future price action into a supposedly predictive order.

Windows with non-positive net buy flow are classified as **distribution** and excluded from wallet-leader evidence (kept for forensics). Leaders must show strictly pre-pump buys; pure early-pump chasers stay in observations and buy events but cannot rank.

`predictiveQualified` marks the ML-ready subset: repeated (2+) pre-pump pumps **and** repeated (2+) control-sufficient pumps. Everything else remains as observational evidence.

## Parser diagnostics

`response.json` stores transaction-level parse reasons including:

```text
accepted_transactions
accepted_trades
failed_transaction
missing_block_time
missing_signature
no_token_balance
token_delta_zero
wallet_not_signer
missing_wallet_sol_balance
zero_sol_delta
sol_direction_mismatch
router_like_swap
invalid_amount
```

This is important when a token has a much lower trade hit rate than another token.

## DeBot candidate logic

`activityScore` and `pumpPrecursorScore` are separate. The pump-precursor candidate requires genuine positive volume acceleration (`> 1.0x` by default), while heatmap data is contextual rather than a hard gate.

## Cache

Cache files are stored under `data/helius_cache/`. Light history and completed full time ranges have separate TTLs. Cache contents are versioned with the parser version so parser changes invalidate stale results.

## Dependencies

```json
{
  "dependencies": {
    "@duckdb/node-api": "^1.5.5-r.5"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/node": "latest",
    "typescript": "latest"
  }
}
```

The DuckDB layer uses parameterized SQL rather than the native Appender surface because Bun 1.4.x does not consistently expose the documented Node Neo Appender methods.

## Configuration

All non-CLI settings are read from `.env`. The supplied configuration is tuned for a 2 GB RAM / 1–2 vCPU VPS (a 16 GB workstation can raise the budgets; notes are inline):

- serial token processing
- 350 ms Helius minimum request interval
- 1,000 signature records/request for discovery
- 4 active 5-minute windows
- 1 quiet reconnaissance window
- 2,500 estimated full transactions per planned range
- 32 maximum planned full-query ranges (fail-closed, never truncated)
- 100,000 maximum light-scan signatures per token (fail-fast density guard)
- 24 h artifact skip for DeBot re-scans (`RESCAN_SKIP_SEC`)
- 120-second pump clustering
- 120-second pre-pump wallet context
- 30-second forward observation slack for sparse tokens
- DuckDB capped to 1 thread / 600 MB with disk spill

These are research starting values and should be validated across many tokens.

## Paper copy-trading (`paper-copy/`)

A separate Bun service (own oxmgr app) watches the top leader wallets and paper-trades their entries at 0.05 SOL with a TP ladder, trailing stop, and Telegram alerts (grammy + MarkdownV2). No chain execution anywhere: all market data is read-only and positions live in `paper-copy/paper_state.json`.

- entry gates: copy-size buys only, liquidity/mcap/age bounds, RugCheck danger veto
- exits: TP ladder partials, trailing stop (tightens after first partial), max-hold timeout
- guards: 1 open position per wallet, 3 opens per wallet per day, momentum-chase veto (>+20% m5), entry circuit breaker on Helius errors
- ledger self-audit every sweep plus state backups
- Helius sweep is two-tier: cheap signatures-only change detection, full parsing of the fresh delta only

```bash
cd paper-copy && bun install
bun run check   # tsc --noEmit
bun run test    # unit tests (engine lifecycle, gates, ranking)
```

## Version 11 changes

- Full fetch ranges merge on actual overlap before splitting, preventing double billing of intersecting ranges.
- Planner range counting uses cached sorted-prefix indexes instead of repeatedly scanning the full fine-bucket map.
- Dense windows are split from lightweight counts; no silent first-N-page truncation.
- Quiet pre-spike reconnaissance remains enabled.
- Light/full on-disk caches support repeatable multi-token research.
- Early-pump buys and insufficient control baselines are retained as explicit evidence.
- DeBot requires volume acceleration above 1.0x for pump-precursor candidates.
- One-token-at-a-time processing remains mandatory for predictable memory use.

## Later hardening (same v11 lineage)

- Fail-closed budgets: density cap, window cap, no truncation anywhere; failures recorded with `scan_status`.
- Provenance: `run_id` + scan timestamps on every table and artifact.
- Entry/outcome split: prospective ranking on entry evidence only; forwards stay labels.
- Distribution exclusion, pre-pump leadership requirement, `predictiveQualified` (2+ pre-pump and 2+ backed pumps).
- Router-aware parser diagnostics (`router_like_swap` split out of direction mismatches).
- DeBot liquidity/market-cap regime buckets; explicit `--token` runs skip DeBot requests.
- Top PnL candidate files (`--candidate-file`) with match snapshots.
- Operational: flock single-instance guard, cron-skip logging, exit-proof logging, fresh-artifact rescan skip, DuckDB memory cap.
- `paper-copy/` paper-trading service and `tests/` regression suite (`bun run test`).
