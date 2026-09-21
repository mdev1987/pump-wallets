import { readFile } from 'node:fs/promises';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type CandidateSource = 'top_pnl' | 'manual';

/**
 * A wallet candidate discovered outside the Helius event analyzer.
 *
 * Top PnL is intentionally represented as a discovery prior only. None of
 * these fields are used to calculate the prospective wallet evidence score.
 */
export type WalletCandidate = {
  source: CandidateSource;
  tokenCa: string;
  wallet: string;
  candidateRank: number | null;
  totalPnlUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  positionUsd: number | null;
  entrySizeUsd: number | null;
  tokenBalance: number | null;
  observedAt: string | null;
};

function normalizedHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  fields.push(current.trim());
  if (quoted) throw new Error('Malformed CSV row: unmatched quote');
  return fields;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;
  const accountingNegative = raw.startsWith('(') && raw.endsWith(')');
  const normalized = raw
    .replace(/^\$/, '')
    .replace(/,/g, '')
    .replace(/%$/, '')
    .replace(/[()]/g, '')
    .trim();
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return accountingNegative ? -number : number;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function validateAddress(value: unknown, field: string): string {
  const address = stringOrNull(value);
  if (!address || !SOLANA_ADDRESS_RE.test(address)) {
    throw new Error(`Invalid ${field}: ${String(value)}`);
  }
  return address;
}

function candidateFromRecord(
  record: Record<string, unknown>,
  source: CandidateSource,
): WalletCandidate {
  const tokenCa = validateAddress(
    pick(record, ['token_ca', 'token', 'contract', 'contract_address', 'mint', 'address']),
    'token_ca',
  );
  const wallet = validateAddress(
    pick(record, ['wallet', 'wallet_address', 'wallet_ca', 'owner']),
    'wallet',
  );

  return {
    source,
    tokenCa,
    wallet,
    candidateRank: numberOrNull(pick(record, ['rank', 'candidate_rank', 'pnl_rank'])),
    totalPnlUsd: numberOrNull(pick(record, ['total_pnl_usd', 'total_pnl', 'pnl_usd', 'pnl'])),
    realizedPnlUsd: numberOrNull(pick(record, ['realized_pnl_usd', 'realized_pnl'])),
    unrealizedPnlUsd: numberOrNull(pick(record, ['unrealized_pnl_usd', 'unrealized_pnl'])),
    positionUsd: numberOrNull(pick(record, ['position_usd', 'position_size_usd', 'position_size'])),
    entrySizeUsd: numberOrNull(pick(record, ['entry_size_usd', 'entry_size', 'buy_value_usd'])),
    tokenBalance: numberOrNull(pick(record, ['token_balance', 'balance'])),
    observedAt: stringOrNull(pick(record, ['observed_at', 'observed_at_utc', 'timestamp', 'time'])),
  };
}

function parseJson(text: string, source: CandidateSource): WalletCandidate[] {
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : null;

  if (!rows) throw new Error('Candidate JSON must be an array or {"candidates": [...]}');

  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Candidate row ${index + 1} must be an object`);
    }
    return candidateFromRecord(row as Record<string, unknown>, source);
  });
}

function parseCsv(text: string, source: CandidateSource): WalletCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]!).map(normalizedHeader);
  if (!headers.length) return [];

  return lines.slice(1).map((line, rowIndex) => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) {
      throw new Error(`Candidate CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    return candidateFromRecord(record, source);
  });
}

/** Read a Top PnL export saved as CSV or JSON. */
export async function readTopPnlCandidates(path: string): Promise<WalletCandidate[]> {
  const text = await readFile(path, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];

  const source: CandidateSource = 'top_pnl';
  const rows = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? parseJson(trimmed, source)
    : parseCsv(trimmed, source);

  const unique = new Map<string, WalletCandidate>();
  for (const row of rows) {
    const key = `${row.source}:${row.tokenCa}:${row.wallet}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, row);
      continue;
    }

    // Keep the best populated fields from duplicate exports while preserving
    // the earliest explicit candidate rank when available.
    unique.set(key, {
      ...existing,
      candidateRank: existing.candidateRank ?? row.candidateRank,
      totalPnlUsd: existing.totalPnlUsd ?? row.totalPnlUsd,
      realizedPnlUsd: existing.realizedPnlUsd ?? row.realizedPnlUsd,
      unrealizedPnlUsd: existing.unrealizedPnlUsd ?? row.unrealizedPnlUsd,
      positionUsd: existing.positionUsd ?? row.positionUsd,
      entrySizeUsd: existing.entrySizeUsd ?? row.entrySizeUsd,
      tokenBalance: existing.tokenBalance ?? row.tokenBalance,
      observedAt: existing.observedAt ?? row.observedAt,
    });
  }

  return [...unique.values()];
}

export function candidatesForToken(candidates: WalletCandidate[], tokenCa: string): WalletCandidate[] {
  return candidates.filter((candidate) => candidate.tokenCa === tokenCa);
}
