/**
 * Pontuação histórica das candidatas Supremo (faz rede: velas de 1 min).
 * A matemática fica em src/lib/supremo-hitrate.ts e src/lib/supremo-live.ts.
 */
import { planBet, type HourAnalysis, type LiveBlock } from "@/lib/supremo";
import { getMinuteCandles24h, mapSettled } from "@/lib/supremo-data";
import { hitRateReport, type HitRateReport } from "@/lib/supremo-hitrate";
import { entryBlocks, isStablecoin, type SelectionRow } from "@/lib/supremo-live";
import { planCombo } from "@/lib/target-stop-lab";
import type { ActiveCombo } from "@/lib/supremo-combo";
import type { ResolvedCombo } from "@/lib/supremo-combo-profiles";

/** Quantas candidatas (por índice) recebem estatística mesmo longe do gatilho, para o painel. */
export const DISPLAY_CANDIDATES = 12;

export type ScoredRow = SelectionRow & {
  quote: string;
  analysis: HourAnalysis;
  plan: { target: number; trigger: number; stop: number } | null;
  report: HitRateReport | null;
  /** Combinação usada para pontuar ESTA moeda — a mesma que vai para a aposta. */
  combo: ActiveCombo;
  comboSource: "perfil" | "global";
  comboReason: string;
};

export async function scoreRows(
  rows: readonly (SelectionRow & { quote: string; analysis: HourAnalysis })[],
  combo: ActiveCombo | ((symbol: string) => ResolvedCombo),
  now: number,
  signal?: AbortSignal,
): Promise<ScoredRow[]> {
  const resolve = (symbol: string): ResolvedCombo =>
    typeof combo === "function" ? combo(symbol) : { combo, source: "global", reason: "combinação global" };
  const prepared = rows.map((r) => {
    const rc = resolve(r.symbol);
    const c = rc.combo;
    const base = r.price != null ? planBet(r.analysis, r.price) : null;
    const plan = base ? planCombo(base.target, c.targetPct, c.stopPct, c.mode) : null;
    const extra = entryBlocks({ symbol: r.symbol, price: r.price, plan });
    return { r, plan, extra, rc };
  });
  // Recebem estatística: todas as liberadas + as melhores por índice (para o painel).
  const clean = prepared.filter((p) => p.r.blocks.length === 0 && p.plan && !isStablecoin(p.r.symbol));
  const want = new Set<string>([
    ...clean.filter((p) => p.extra.length === 0).map((p) => p.r.symbol),
    ...[...clean]
      .filter((p) => !p.extra.includes("alvo-ultrapassado"))
      .sort((a, b) => b.r.analysis.index - a.r.analysis.index)
      .slice(0, DISPLAY_CANDIDATES)
      .map((p) => p.r.symbol),
  ]);
  const targets = prepared.filter((p) => want.has(p.r.symbol));
  const res = await mapSettled(targets, (p) => getMinuteCandles24h(p.r.symbol, now, signal), () => {}, signal);
  if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
  const reports = new Map<string, HitRateReport>();
  targets.forEach((p, i) => {
    const x = res[i];
    if (x?.ok && p.plan) {
      reports.set(p.r.symbol, hitRateReport({ symbol: p.r.symbol, candles: x.value, plan: p.plan, price: p.r.price, now }));
    }
  });
  return prepared.map(({ r, plan, extra, rc }) => {
    const report = reports.get(r.symbol) ?? null;
    const extraFull = report
      ? entryBlocks({ symbol: r.symbol, price: r.price, plan, range24h: report.faixa24h, abaixoEquilibrio: report.abaixoEquilibrio })
      : extra;
    const blocks: LiveBlock[] = [...r.blocks, ...extraFull.filter((b) => !r.blocks.includes(b))];
    // Moeda liberada sem estatística não pode ser escolhida.
    if (blocks.length === 0 && !report) blocks.push("dados-velhos");
    return {
      ...r,
      blocks,
      plan,
      report,
      combo: rc.combo,
      comboSource: rc.source,
      comboReason: rc.reason,
      ...(report
        ? {
            score: report.pontuacao,
            stars: report.estrelas,
            hitRate: report.principal.taxaAcerto,
            cycles: report.principal.alvos + report.principal.stops,
          }
        : {}),
    };
  });
}
