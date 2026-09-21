/**
 * TON paper-tracking helpers (pure logic, no network).
 *
 * Two paper scenarios per token:
 *   - "now":    entry at the first observed live price (exact from here on).
 *   - "late4h": entry at the estimated price 4h before tracking started.
 * Both reuse the shared TP-partial / trailing-stop engine with USD
 * denomination and no max-hold timeout (this is a tracker, not a trader).
 */
import {
  DEFAULT_CONFIG,
  type EngineConfig,
  type Position,
} from '../paper-copy/engine';

export const TON_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  posSizeSol: 25, // USD units (unitLabel below makes reports read USD)
  feeOpenSol: 0.05,
  feeLegSol: 0.02,
  unitLabel: 'USD',
  maxHoldSec: 0, // disabled: tracker holds indefinitely for comparison
};

/**
 * Wide pump-catcher: high TP with a moonbag runner, wide trailing stop,
 * 24h max hold. Exits only on TP2 / trailing breach / timeout / manual
 * /close — never on chop. Matches "don't quick the pos except on high risk".
 */
export const PUMP_CONFIG: EngineConfig = {
  ...TON_CONFIG,
  // Ladder: skim 20% at +100% and +200%, let 60% ride the pump.
  tpLadder: [
    { pct: 1.0, share: 0.2 },
    { pct: 2.0, share: 0.2 },
  ],
  trailPct: 0.45, // wide: survive -45% drawdowns, exit only on real risk
  trailTightPct: 0.45, // no tightening: wide throughout by design
  maxHoldSec: 24 * 3600,
};

/** Raw TON address (48-char base64url, EQ/UQ mainnet prefixes). */
export function isTonAddress(s: string): boolean {
  return /^[EU][QF][A-Za-z0-9_-]{46}$/.test(s.trim());
}

export type ParsedOpen =
  | { ok: true; mint: string; sizeUsd: number }
  | { ok: false; error: string };

/** Parse `/open <CA> [usd]`. Pure for testability. */
export function parseOpenCommand(text: string, defaultSizeUsd: number): ParsedOpen {
  const parts = text.trim().split(/\s+/).slice(1); // drop /open[@bot]
  const [mintRaw = '', sizeRaw] = parts;
  if (!mintRaw || !isTonAddress(mintRaw)) {
    return { ok: false, error: 'Usage: /open <TON_CA> [usd] — e.g. `/open EQCX…2u7bY 25`' };
  }
  let sizeUsd = defaultSizeUsd;
  if (sizeRaw !== undefined) {
    sizeUsd = Number(sizeRaw);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0 || sizeUsd > 10_000) {
      return { ok: false, error: 'Size must be a number 0–10000 (USD).' };
    }
  }
  return { ok: true, mint: mintRaw.trim(), sizeUsd };
}

/** Find an open position by full mint or unambiguous prefix. Pure. */
export function findOpenByMint<T extends { mint: string; status: string }>(
  positions: T[],
  query: string,
): { found: T[] } {
  const q = query.trim();
  const found = positions.filter((p) => p.status === 'open' && (p.mint === q || (q.length >= 8 && p.mint.startsWith(q))));
  return { found };
}

export type DexQuote = {
  priceUsd: number | null;
  liqUsd: number | null;
  mcapUsd: number | null;
  vol24Usd: number | null;
  buys24h: number | null;
  chgH1: number | null;
  chgH6: number | null;
  chgH24: number | null;
  symbol: string;
  dex: string;
  pairCreatedAtMs: number | null;
};

/**
 * Estimate the price `hoursAgo` hours back from trailing window changes.
 * Uses the bracketing windows around the target in log space; beyond the
 * widest window it extrapolates that window's hourly rate. Compounding is
 * never even in reality, so ALWAYS label the result ESTIMATED. Exact
 * tracking starts at the first live tick.
 */
export function estimatePriceHoursAgo(
  priceNow: number,
  hoursAgo: number,
  chg: { h1: number | null; h6: number | null; h24: number | null },
): number | null {
  if (!(priceNow > 0) || !(hoursAgo > 0)) return null;
  const pts: Array<[number, number]> = [];
  for (const [h, c] of [[1, chg.h1], [6, chg.h6], [24, chg.h24]] as Array<[number, number | null]>) {
    if (c !== null && Number.isFinite(c) && c > -100) pts.push([h, c / 100]);
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a[0] - b[0]);
  if (hoursAgo <= pts[0]![0]) {
    // Inside the shortest window: pro-rate its hourly rate.
    const hourly = Math.pow(Math.max(1e-9, 1 + pts[0]![1]), 1 / pts[0]![0]);
    return priceNow / Math.pow(hourly, hoursAgo);
  }
  let lo = pts[0]!;
  let hi: [number, number] | null = null;
  for (const p of pts) {
    if (p[0] <= hoursAgo) lo = p;
    else {
      hi = p;
      break;
    }
  }
  if (hi === null) {
    const hourly = Math.pow(Math.max(1e-9, 1 + lo[1]), 1 / lo[0]);
    return priceNow / Math.pow(hourly, hoursAgo);
  }
  // Log-linear between bracketing windows: interpolate the log-growth rate.
  const rLo = Math.log(Math.max(1e-9, 1 + lo[1])) / lo[0]; // per-hour
  const rHi = Math.log(Math.max(1e-9, 1 + hi[1])) / hi[0]; // per-hour
  const t = (hoursAgo - lo[0]) / (hi[0] - lo[0]);
  const r = rLo + t * (rHi - rLo);
  return priceNow / Math.exp(r * hoursAgo);
}

export type { Position };
