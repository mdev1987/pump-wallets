import type { AnalysisResponse, WalletLeader, WalletPumpObservation } from './analyzer';
import type { WalletCandidate } from './candidates';

export type CandidateMatchStatus =
  | 'matched_leader'
  | 'observed_non_leader'
  | 'not_observed';

export type CandidateWalletSnapshot = WalletCandidate & {
  runId: string;
  scanStatus: 'completed' | 'error' | 'budget_exceeded' | 'light_history_too_dense';
  matchStatus: CandidateMatchStatus;
  observationPumps: number;
  entryEvidenceScore: number | null;
  prePumpPumps: number | null;
  controlBackedPumps: number | null;
  medianSecondsBeforePump: number | null;
  prePumpBuySol: number | null;
  pumpCount: number | null;
  qualificationReason: string | null;
};

/** Join an external candidate record to the deterministic Helius token analysis. */
export function snapshotCandidate(
  candidate: WalletCandidate,
  response: AnalysisResponse,
  status: CandidateWalletSnapshot['scanStatus'] = 'completed',
): CandidateWalletSnapshot {
  const leader: WalletLeader | undefined = response.walletLeaders.find(
    (row) => row.wallet === candidate.wallet,
  );
  const observations: WalletPumpObservation[] = response.walletPumpObservations.filter(
    (row) => row.wallet === candidate.wallet,
  );

  if (leader && leader.prePumpPumps > 0) {
    return {
      ...candidate,
      runId: response.runId,
      scanStatus: status,
      matchStatus: 'matched_leader',
      observationPumps: observations.length,
      entryEvidenceScore: leader.entryEvidenceScore,
      prePumpPumps: leader.prePumpPumps,
      controlBackedPumps: leader.controlBackedPumps,
      medianSecondsBeforePump: leader.medianSecondsBeforePump,
      prePumpBuySol: leader.prePumpBuySol,
      pumpCount: leader.pumpCount,
      qualificationReason: leader.qualificationReason,
    };
  }

  return {
    ...candidate,
    runId: response.runId,
    scanStatus: status,
    matchStatus: leader || observations.length ? 'observed_non_leader' : 'not_observed',
    observationPumps: observations.length,
    entryEvidenceScore: null,
    prePumpPumps: null,
    controlBackedPumps: null,
    medianSecondsBeforePump: null,
    prePumpBuySol: null,
    pumpCount: observations.length,
    qualificationReason: observations.length
      ? 'Wallet was observed in the token-local population but did not demonstrate pre-pump leadership.'
      : 'Wallet was not observed in the token-local Helius population.',
  };
}
