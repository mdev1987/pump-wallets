# Solana Pump Wallet Research — Final v11

Memory-safe, multi-token Solana pump-window and wallet-leader research pipeline.

## Pipeline

```text
DeBot 1m + 5m + heatmap
        ↓
pump-precursor candidates
        ↓
one token at a time
        ↓
Helius signatures-only history
        ↓
1-minute activity buckets + 1-second fine buckets
        ↓
busiest windows + quiet pre-spike reconnaissance
        ↓
union overlapping fetch ranges
        ↓
recursively split dense ranges
        ↓
Helius full transactions only for selected ranges
        ↓
parse each page immediately / discard raw page
        ↓
adaptive fast + sustained pump detection
        ↓
wallet × pump observations
        ↓
DuckDB + per-token JSON/CSV
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
```

With no explicit tokens, DeBot candidates are used when enabled. Explicit tokens are always analyzed.

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
tokens
pump_windows
control_baselines
wallet_pump_observations
pump_buy_events
wallet_token_summary
wallet_global_summary
debot_signals
```

Global CSV exports are written under `data/pump_wallet_exports/`.

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

All non-CLI settings are read from `.env`. The supplied configuration is deliberately conservative for a 16 GB RAM / 8th-generation i7 workstation:

- serial token processing
- 250 ms Helius minimum request interval
- 1,000 signature records/request for discovery
- 8 active 5-minute windows
- 2 quiet reconnaissance windows
- 5,000 estimated full transactions per planned range
- 64 maximum planned full-query ranges
- 120-second pump clustering
- 120-second pre-pump wallet context
- 30-second forward observation slack for sparse tokens

These are research starting values and should be validated across many tokens.

## Version 11 changes

- Full fetch ranges merge on actual overlap before splitting, preventing double billing of intersecting ranges.
- Planner range counting uses cached sorted-prefix indexes instead of repeatedly scanning the full fine-bucket map.
- Dense windows are split from lightweight counts; no silent first-N-page truncation.
- Quiet pre-spike reconnaissance remains enabled.
- Light/full on-disk caches support repeatable multi-token research.
- Early-pump buys and insufficient control baselines are retained as explicit evidence.
- DeBot requires volume acceleration above 1.0x for pump-precursor candidates.
- One-token-at-a-time processing remains mandatory for predictable memory use.
