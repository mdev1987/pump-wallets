import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readTopPnlCandidates } from '../src/candidates';
import { snapshotCandidate } from '../src/candidate_store';

const dir = './data/test-candidates';
const token = 'So11111111111111111111111111111111111111112';
const wallet = '11111111111111111111111111111111';

async function write(name: string, contents: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${name}`;
  await writeFile(path, contents, 'utf8');
  return path;
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Top PnL candidate loader', () => {
  test('reads CSV, normalizes headers, and deduplicates token/wallet pairs', async () => {
    const path = await write('top-pnl.csv', [
      'Token CA,Wallet,Total PnL,Realized PnL,Position Size',
      `${token},${wallet},1250,1000,500`,
      `${token},${wallet},1250,,`,
    ].join('\n'));

    const candidates = await readTopPnlCandidates(path);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('top_pnl');
    expect(candidates[0]?.totalPnlUsd).toBe(1250);
    expect(candidates[0]?.realizedPnlUsd).toBe(1000);
    expect(candidates[0]?.positionUsd).toBe(500);
  });

  test('reads JSON object form and requires valid token/wallet addresses', async () => {
    const path = await write('top-pnl.json', JSON.stringify({
      candidates: [{ token_ca: token, wallet, rank: 1, total_pnl_usd: 42 }],
    }));

    const candidates = await readTopPnlCandidates(path);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.candidateRank).toBe(1);
    expect(candidates[0]?.totalPnlUsd).toBe(42);
  });

  test('rejects invalid addresses', async () => {
    const path = await write('bad.csv', [
      'token_ca,wallet',
      `not-an-address,${wallet}`,
    ].join('\n'));
    await expect(readTopPnlCandidates(path)).rejects.toThrow();
  });
});


describe('candidate snapshot classification', () => {
  const candidate = {
    source: 'top_pnl' as const,
    tokenCa: token,
    wallet,
    candidateRank: 1,
    totalPnlUsd: 100,
    realizedPnlUsd: 90,
    unrealizedPnlUsd: 10,
    positionUsd: 50,
    entrySizeUsd: 25,
    tokenBalance: 10,
    observedAt: null,
  };

  test('marks a pre-pump wallet as matched_leader', () => {
    const response = {
      runId: 'run-1',
      walletLeaders: [{
        wallet, prePumpPumps: 2, entryEvidenceScore: 3.2, controlBackedPumps: 2,
        medianSecondsBeforePump: 10, prePumpBuySol: 1.5, pumpCount: 2, qualificationReason: 'ok',
      }],
      walletPumpObservations: [{ wallet, pumpId: 1 }]
    } as any;
    const snapshot = snapshotCandidate(candidate, response);
    expect(snapshot.matchStatus).toBe('matched_leader');
    expect(snapshot.prePumpPumps).toBe(2);
  });

  test('keeps a chaser in the denominator as observed_non_leader', () => {
    const response = {
      runId: 'run-2',
      walletLeaders: [{
        wallet, prePumpPumps: 0, entryEvidenceScore: 0, controlBackedPumps: 0,
        medianSecondsBeforePump: null, prePumpBuySol: 0, pumpCount: 1, qualificationReason: 'chaser',
      }],
      walletPumpObservations: [{ wallet, pumpId: 1 }]
    } as any;
    const snapshot = snapshotCandidate(candidate, response);
    expect(snapshot.matchStatus).toBe('observed_non_leader');
    expect(snapshot.entryEvidenceScore).toBeNull();
  });

  test('marks an absent wallet as not_observed', () => {
    const response = { runId: 'run-3', walletLeaders: [], walletPumpObservations: [] } as any;
    const snapshot = snapshotCandidate(candidate, response);
    expect(snapshot.matchStatus).toBe('not_observed');
    expect(snapshot.pumpCount).toBe(0);
  });
});
