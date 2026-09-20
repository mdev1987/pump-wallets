/**
 * Fresh-artifact skip for DeBot-candidate re-scans.
 *
 * Lives in its own side-effect-free module so bun:test can import it without
 * pulling in get_pump_wallets.ts (whose top-level main() would start a scan).
 */

/**
 * Skip a DeBot-candidate re-scan while its response.json artifact is fresh.
 * Re-analysis within cache TTLs reproduces the identical result for full
 * Helius cost, and budget-skipped tokens fail identically every run — both
 * are pure waste. Explicit --token scans bypass this (handled by the caller).
 * Missing, unparseable or undated artifacts fail open to scanning.
 */
export function shouldSkipRescan(
  artifact: { scannedAt?: unknown; status?: unknown } | null,
  nowMs: number,
  skipSec: number,
): boolean {
  if (skipSec <= 0 || !artifact || typeof artifact.scannedAt !== 'string') return false;
  const scannedMs = Date.parse(artifact.scannedAt);
  if (!Number.isFinite(scannedMs)) return false;
  return nowMs - scannedMs < skipSec * 1000;
}
