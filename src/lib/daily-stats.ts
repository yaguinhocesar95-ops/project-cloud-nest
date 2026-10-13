/**
 * Resumo do dia gravado ANTES do reset da meia-noite (Brasília), para acumular
 * amostra entre dias sem mudar o reset.
 */
import type { Bet } from "@/hooks/useBets";
import { FEE_ROUND_TRIP_PCT } from "@/lib/scalp";

export type DailyStats = {
  day: string;
  bets: number;
  wins: number;
  losses: number;
  /** Soma do resultado líquido por aposta, em fração (0,0035 = +0,35%). */
  net_pct: number;
  by_coin: Record<string, { wins: number; losses: number; net_pct: number }>;
  combo: string | null;
  regime: string | null;
};

/** Resultado líquido de uma aposta encerrada (fração do valor exposto). */
export function netPct(b: Pick<Bet, "status" | "entryPrice" | "target" | "stop">): number {
  if (b.status === "win") return b.target / b.entryPrice - 1 - FEE_ROUND_TRIP_PCT;
  if (b.status === "loss") return b.stop / b.entryPrice - 1 - FEE_ROUND_TRIP_PCT;
  return 0;
}

const mostCommon = (xs: (string | undefined | null)[]): string | null => {
  const m = new Map<string, number>();
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  let best: string | null = null, n = 0;
  for (const [k, v] of m) if (v > n) { best = k; n = v; }
  return best;
};

export function summarizeDay(day: string, bets: readonly Bet[]): DailyStats {
  const done = bets.filter((b) => b.status === "win" || b.status === "loss");
  const by_coin: DailyStats["by_coin"] = {};
  let net = 0, wins = 0;
  for (const b of done) {
    const n = netPct(b);
    net += n;
    if (b.status === "win") wins++;
    const c = (by_coin[b.symbol] ??= { wins: 0, losses: 0, net_pct: 0 });
    if (b.status === "win") c.wins++; else c.losses++;
    c.net_pct += n;
  }
  return {
    day, bets: bets.length, wins, losses: done.length - wins, net_pct: net, by_coin,
    combo: mostCommon(bets.map((b) => b.combo)), regime: mostCommon(bets.map((b) => b.regimeAtCreate)),
  };
}

/** Totais de vários dias: acerto e expectativa líquida por aposta. */
export function aggregateDays(rows: readonly Pick<DailyStats, "wins" | "losses" | "net_pct">[]) {
  const wins = rows.reduce((s, r) => s + r.wins, 0);
  const losses = rows.reduce((s, r) => s + r.losses, 0);
  const net = rows.reduce((s, r) => s + Number(r.net_pct), 0);
  const n = wins + losses;
  return { wins, losses, n, hitRate: n ? wins / n : null, expectancy: n ? net / n : null };
}
