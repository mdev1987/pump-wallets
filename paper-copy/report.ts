/**
 * Per-wallet performance report from paper_state.json.
 *
 * Usage:
 *   bun run report.ts              # human table to stdout
 *   bun run report.ts --json       # machine-readable
 *   bun run report.ts --min=5      # only wallets with >= N trades (default 1)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WALLET_TOXIC_MAX_EXPECTANCY,
  WALLET_TOXIC_MIN_TRADES,
  leadBuckets,
  type LeadBucket,
} from "./engine";

export type ClosedRow = {
  id: string;
  mint: string;
  symbol: string;
  wallet?: string;
  pnlSol: number;
  win: boolean;
  atMs: number;
  holdMs?: number;
  closeReason?: string | null;
  leaderBuyTs?: number;
};

export type PositionRow = {
  id: string;
  wallet: string;
  walletLabel?: string;
  symbol: string;
  mint: string;
  status: "open" | "closed";
  openedAtMs: number;
  pnlSol?: number;
  feeOpenSol?: number;
  closeReason?: string | null;
  legs?: Array<{ pnlSol: number; qtyTokens: number; priceUsd: number; atMs: number }>;
  leaderBuyTs?: number;
  remainingQty?: number;
  qtyTokens?: number;
};

export type Ledger = {
  cashSol: number;
  reservedSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  positions: PositionRow[];
  closed: ClosedRow[];
  auditOffset?: number;
};

export type TradeRow = {
  wallet: string;
  walletLabel: string;
  symbol: string;
  pnlSol: number;
  win: boolean;
  openedAtMs: number;
  closedAtMs: number;
  holdMs: number;
  closeReason: string;
  /** Entry latency: our open time minus leader buy time (ms). Missing when unknown. */
  leadMs: number | null;
};

export type WalletStats = {
  wallet: string;
  walletLabel: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlSol: number;
  avgPnlSol: number;
  expectancySol: number;
  avgWinSol: number;
  avgLossSol: number;
  profitFactor: number | null;
  medianHoldMs: number | null;
  avgHoldMs: number | null;
  avgLeadMs: number | null;
  leadSamples: number;
  closeReasons: Record<string, number>;
  shareOfTrades: number;
  shareOfPnl: number;
  openNow: number;
  toxic: boolean;
  toxicReason: string | null;
};

export type Report = {
  generatedAtMs: number;
  totalTrades: number;
  totalWins: number;
  winRate: number;
  /** Sum of closed[]: the true book PnL from trading. */
  totalPnlSol: number;
  expectancySol: number;
  cashSol: number;
  reservedSol: number;
  /** Ledger counter: book PnL + legacy gap-fold + open fees of live positions. */
  realizedPnlSol: number;
  /** realizedPnlSol - totalPnlSol: legacy/fee residue, not trading edge. */
  ledgerGapSol: number;
  unrealizedPnlSol: number;
  equitySol: number;
  wallets: WalletStats[];
  leadBuckets: LeadBucket[];
  leadSamples: number;
  concentration: {
    topWalletShare: number;
    topWallet: string | null;
    herfindahl: number;
  };
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/**
 * Join closed[] with positions[] for wallet/hold/lead. Falls back to
 * closed.wallet when present (new closes); old rows need a positions join.
 */
export function buildTrades(state: Ledger): TradeRow[] {
  const byId = new Map(state.positions.map((p) => [p.id, p]));
  const rows: TradeRow[] = [];
  for (const c of state.closed) {
    const p = byId.get(c.id);
    const wallet = c.wallet ?? p?.wallet ?? "unknown";
    const openedAtMs = p?.openedAtMs ?? c.atMs;
    const holdMs = c.holdMs ?? Math.max(0, c.atMs - openedAtMs);
    const leaderBuyTs = c.leaderBuyTs ?? p?.leaderBuyTs;
    // Guard absurd leads (>24h either way): protects against s/ms unit mix
    // in historical rows. Raw Helius seconds must be normalized at ingestion.
    const rawLead = leaderBuyTs != null ? openedAtMs - leaderBuyTs : null;
    const leadMs = rawLead != null && Number.isFinite(rawLead) && Math.abs(rawLead) <= 86_400_000 ? rawLead : null;
    const pnl = Number.isFinite(c.pnlSol) ? c.pnlSol : (pnlFromPos(p) ?? 0);
    rows.push({
      wallet,
      walletLabel: p?.walletLabel ?? wallet.slice(0, 6) + "…" + wallet.slice(-4),
      symbol: c.symbol || p?.symbol || "?",
      pnlSol: pnl,
      win: pnl > 0,
      openedAtMs,
      closedAtMs: c.atMs,
      holdMs,
      closeReason: c.closeReason ?? p?.closeReason ?? "unknown",
      leadMs,
    });
  }
  return rows;
}

function pnlFromPos(p: PositionRow | undefined): number | null {
  if (!p) return null;
  const legSum = (p.legs ?? []).reduce((s, l) => s + (l.pnlSol || 0), 0);
  if (p.pnlSol && p.pnlSol !== 0) return p.pnlSol - (p.feeOpenSol ?? 0);
  if (legSum) return legSum - (p.feeOpenSol ?? 0);
  return null;
}

const TOXIC_MIN_TRADES = WALLET_TOXIC_MIN_TRADES;
const TOXIC_MAX_EXPECTANCY = WALLET_TOXIC_MAX_EXPECTANCY; // SOL per trade

export function summarizeWallet(
  wallet: string,
  trades: TradeRow[],
  openNow: number,
  totalTrades: number,
  totalPnl: number,
): WalletStats {
  const pnls = trades.map((t) => t.pnlSol);
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const winSum = wins.reduce((s, t) => s + t.pnlSol, 0);
  const lossSum = losses.reduce((s, t) => s + t.pnlSol, 0);
  const total = pnls.reduce((s, x) => s + x, 0);
  const expectancy = trades.length ? total / trades.length : 0;
  const holds = trades.map((t) => t.holdMs);
  const leads = trades.map((t) => t.leadMs).filter((x): x is number => x != null);
  const closeReasons: Record<string, number> = {};
  for (const t of trades) {
    const k = t.closeReason || "unknown";
    closeReasons[k] = (closeReasons[k] ?? 0) + 1;
  }
  const pfDenom = Math.abs(lossSum);
  const label = trades[0]?.walletLabel ?? wallet;
  const toxic =
    trades.length >= TOXIC_MIN_TRADES && expectancy < TOXIC_MAX_EXPECTANCY;
  const toxicReason = toxic
    ? `${trades.length} trades, expectancy ${expectancy.toFixed(4)} SOL/trade`
    : null;
  return {
    wallet,
    walletLabel: label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnlSol: total,
    avgPnlSol: trades.length ? total / trades.length : 0,
    expectancySol: expectancy,
    avgWinSol: wins.length ? winSum / wins.length : 0,
    avgLossSol: losses.length ? lossSum / losses.length : 0,
    profitFactor: pfDenom > 1e-12 ? winSum / pfDenom : null,
    medianHoldMs: median(holds),
    avgHoldMs: mean(holds),
    avgLeadMs: mean(leads),
    leadSamples: leads.length,
    closeReasons,
    shareOfTrades: totalTrades ? trades.length / totalTrades : 0,
    // Share of |total| keeps winners positive and losers negative when the
    // book itself is red (plain total/totalPnl flips the signs).
    shareOfPnl: totalPnl !== 0 ? total / Math.abs(totalPnl) : 0,
    openNow,
    toxic,
    toxicReason: toxic && !toxicReason ? "large share of losses" : toxicReason,
  };
}

export function buildReport(state: Ledger): Report {
  const trades = buildTrades(state);
  const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
  const wins = trades.filter((t) => t.win);
  const byWallet = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const arr = byWallet.get(t.wallet) ?? [];
    arr.push(t);
    byWallet.set(t.wallet, arr);
  }
  const openByWallet = new Map<string, number>();
  for (const p of state.positions) {
    if (p.status !== "open") continue;
    openByWallet.set(p.wallet, (openByWallet.get(p.wallet) ?? 0) + 1);
  }
  // Include wallets that only have open positions (no closed trades yet)
  for (const [w, n] of openByWallet) {
    if (!byWallet.has(w)) byWallet.set(w, []);
  }

  const wallets = [...byWallet.entries()]
    .map(([wallet, ts]) =>
      summarizeWallet(wallet, ts, openByWallet.get(wallet) ?? 0, trades.length, totalPnl),
    )
    .sort((a, b) => b.totalPnlSol - a.totalPnlSol || b.trades - a.trades);

  const shares = wallets.map((w) => w.shareOfTrades);
  const herfindahl = shares.reduce((s, x) => s + x * x, 0);
  const top = wallets.reduce<WalletStats | null>(
    (best, w) => (!best || w.trades > best.trades ? w : best),
    null,
  );

  const buckets = leadBuckets(trades);
  return {
    generatedAtMs: Date.now(),
    totalTrades: trades.length,
    totalWins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnlSol: totalPnl,
    expectancySol: trades.length ? totalPnl / trades.length : 0,
    cashSol: state.cashSol,
    reservedSol: state.reservedSol,
    realizedPnlSol: state.realizedPnlSol,
    ledgerGapSol: state.realizedPnlSol - totalPnl,
    unrealizedPnlSol: state.unrealizedPnlSol,
    equitySol: state.cashSol + state.reservedSol + state.unrealizedPnlSol,
    leadBuckets: buckets,
    leadSamples: buckets.reduce((s, b) => s + b.n, 0),
    wallets,
    concentration: {
      topWalletShare: top?.shareOfTrades ?? 0,
      topWallet: top?.wallet ?? null,
      herfindahl,
    },
  };
}

function fmtSol(v: number): string {
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(4)}`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "n/a";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padL(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push("=== PAPER-COPY WALLET REPORT ===");
  lines.push(
    `trades ${r.totalTrades} | wins ${r.totalWins} | winrate ${(r.winRate * 100).toFixed(1)}% | total ${fmtSol(r.totalPnlSol)} SOL | expectancy ${fmtSol(r.expectancySol)} SOL/trade`,
  );
  lines.push(
    `equity ${r.equitySol.toFixed(4)} = cash ${r.cashSol.toFixed(4)} + reserved ${r.reservedSol.toFixed(4)} + unrealized ${r.unrealizedPnlSol.toFixed(4)}`,
  );
  lines.push(
    `book ${fmtSol(r.totalPnlSol)} (closed trades) | ledger realized ${fmtSol(r.realizedPnlSol)} (Δ ${fmtSol(r.ledgerGapSol)} legacy gap + open fees — not trading edge)`,
  );
  lines.push(
    `concentration: top=${r.concentration.topWallet ? r.concentration.topWallet.slice(0, 8) : "n/a"} ${(r.concentration.topWalletShare * 100).toFixed(1)}% of trades | HHI=${r.concentration.herfindahl.toFixed(3)}`,
  );
  lines.push("");
  const header = [
    pad("wallet", 12),
    padL("n", 4),
    padL("win%", 6),
    padL("total", 9),
    padL("expct", 9),
    padL("avgW", 8),
    padL("avgL", 8),
    padL("hold", 7),
    padL("lead", 8),
    padL("open", 5),
    " ",
    "top exits",
  ].join(" ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const w of r.wallets) {
    const reasons = Object.entries(w.closeReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k, v]) => `${k.replace(/ \(.*\)/, "")}×${v}`)
      .join(", ");
    const short = w.walletLabel.length > 12 ? w.wallet.slice(0, 8) + "…" : w.walletLabel;
    lines.push(
      [
        pad(short, 12),
        padL(String(w.trades), 4),
        padL(`${(w.winRate * 100).toFixed(0)}`, 6),
        padL(fmtSol(w.totalPnlSol), 9),
        padL(fmtSol(w.expectancySol), 9),
        padL(fmtSol(w.avgWinSol), 8),
        padL(fmtSol(w.avgLossSol), 8),
        padL(fmtMs(w.medianHoldMs), 7),
        padL(fmtMs(w.avgLeadMs), 8),
        padL(String(w.openNow), 5),
        w.toxic ? "T" : " ",
        reasons,
      ].join(" "),
    );
  }
  const toxic = r.wallets.filter((w) => w.toxic);
  if (toxic.length) {
    lines.push("");
    lines.push("TOXIC (n>=5 and expectancy < 0, or outsized loss share):");
    for (const w of toxic) {
      lines.push(`  ${w.wallet.slice(0, 8)}… ${w.toxicReason ?? ""}`);
    }
  }
  const leadOk = r.wallets.filter((w) => w.leadSamples > 0);
  if (leadOk.length) {
    lines.push("");
    lines.push("lead latency by wallet (open - leader buy):");
    for (const w of leadOk) {
      lines.push(`  ${w.wallet.slice(0, 8)}… avg ${fmtMs(w.avgLeadMs)} over ${w.leadSamples} trades`);
    }
  }
  if (r.leadSamples > 0) {
    lines.push("");
    lines.push("lead vs PnL (do late entries lose?):");
    for (const b of r.leadBuckets) {
      lines.push(
        `  ${b.label}: n=${b.n} winrate=${(b.winRate * 100).toFixed(0)}% total=${fmtSol(b.totalPnlSol)}`,
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const minArg = args.find((a) => a.startsWith("--min="));
  const minN = minArg ? Number(minArg.slice(6)) : 1;
  const statePath = args.find((a) => a.startsWith("--state="))?.slice(8)
    ?? join(import.meta.dir, "paper_state.json");
  const raw = await readFile(statePath, "utf8");
  const state = JSON.parse(raw) as Ledger;
  // Backfill wallet on closed rows from positions when missing (legacy state).
  if (Array.isArray(state.closed) && Array.isArray(state.positions)) {
    const byId = new Map(state.positions.map((p) => [p.id, p]));
    for (const c of state.closed) {
      if (!c.wallet) {
        const p = byId.get(c.id);
        if (p) c.wallet = p.wallet;
      }
      if (c.holdMs == null) {
        const p = byId.get(c.id);
        if (p) c.holdMs = Math.max(0, c.atMs - p.openedAtMs);
      }
      if (c.closeReason == null) {
        const p = byId.get(c.id);
        if (p) c.closeReason = p.closeReason;
      }
      if (c.leaderBuyTs == null) {
        const p = byId.get(c.id);
        if (p?.leaderBuyTs != null) c.leaderBuyTs = p.leaderBuyTs;
      }
    }
  }
  const report = buildReport(state);
  const shown = minN > 1 ? report.wallets.filter((w) => w.trades >= minN) : report.wallets;
  const view = minN > 1 ? { ...report, wallets: shown } : report;
  if (asJson) {
    console.log(JSON.stringify(view, null, 2));
  } else {
    if (minN > 1) {
      console.log(`(header totals are global; table filtered to wallets with n>=${minN})`);
    }
    console.log(formatReport(view));
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
