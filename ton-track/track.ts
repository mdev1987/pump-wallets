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
