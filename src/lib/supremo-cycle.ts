/**
 * Um ciclo completo da trilha Supremo (sem React): busca dados, pontua as
 * moedas, escolhe a melhor e devolve a aposta a registrar. Roda no navegador
 * (hook useSupremoAuto) e no servidor (rodada automática a cada minuto).
 */
import { fetchPairs, type SymbolInfo } from "@/lib/binance";
import type { Candle } from "@/lib/replay";
import { convertMoney } from "@/lib/money";
import { BAND_PCT, HOUR_MS, MIN_REPETICOES, SUPREMO_MAX_AGE_MS, analyzeWindow, liveBlocks, planBet, type LiveBlock } from "@/lib/supremo";
import { getClosedHour, getCurrentHour, getCurrentHourIncremental, getMinuteCandles24h, mapSettled } from "@/lib/supremo-data";
import type { Bankroll } from "@/hooks/useBankroll";
import type { Bet } from "@/hooks/useBets";
import { breakEvenAtivo, readActiveCombo } from "@/lib/supremo-combo";
import { comboLabel, planCombo } from "@/lib/target-stop-lab";
import { comboResolver, opportunityKey, repeatedOpportunity } from "@/lib/supremo-combo-profiles";
import { applyTrauma, readTrauma, writeTrauma } from "@/lib/supremo-trauma";
import { MIN_DATA_FRACTION } from "@/lib/cycle-status";
import { appendAudit, exposureBlock, exposureMotivo, newId, readExposure, selectCoin, type SelectionRow } from "@/lib/supremo-live";
import { scoreRows, type ScoredRow } from "@/hooks/supremoScoring";
import { changeOver, readRegime, regimeBlock, type RegimeReading } from "@/lib/market-regime";
import { coinPenalty, writePenaltySnapshot, type Penalty } from "@/lib/supremo-penalty";
import type { NewBetOpts } from "@/lib/bet-engine";

/** Bloqueios de proteção (regime) para uma moeda. */
export function protectionBlocks(
  _bets: readonly Bet[],
  row: Pick<ScoredRow, "symbol" | "hitRate" | "cycles"> & { combo?: ScoredRow["combo"] },
  regime: RegimeReading["regime"],
  now: number,
): { blocks: LiveBlock[]; notes: string[] } {
  const blocks: LiveBlock[] = [];
  const notes: string[] = [];
  const rb = regimeBlock(regime, { hitRate: row.hitRate, sample: row.cycles, breakEven: breakEvenAtivo(row.combo ?? readActiveCombo()) });
  if (rb) blocks.push(rb);
  void now;
  return { blocks, notes };
}

/** Dados da aposta Supremo a partir de uma candidata pontuada. */
export function betOptsFromRow(
  row: ScoredRow,
  quote: string,
  bankroll: Bankroll,
  usdtBrl: number | null,
  regime: string | undefined,
): (NewBetOpts & { symbol: string; combo: string }) | null {
  if (row.price == null) return null;
  // Usa a combinação com que a linha foi pontuada (nunca relê a global).
  const combo = row.combo;
  const label = comboLabel(combo.targetPct, combo.stopPct, combo.mode);
  const base = planBet(row.analysis, row.price);
  if (!base && !row.plan) return null;
  const plan = row.plan ?? planCombo(base!.target, combo.targetPct, combo.stopPct, combo.mode);
  return {
    symbol: row.symbol,
    quote,
    priceNow: row.price,
    triggerPrice: plan.trigger,
    target: plan.target,
    stop: plan.stop,
    hitRate: row.report?.principal.taxaAcerto ?? 0,
    sampleSize: row.analysis.index,
    supremoMeta: row.report
      ? {
          score: row.report.pontuacao,
          stars: row.report.estrelas,
          hitRate: row.report.principal.taxaAcerto,
          cycles: row.cycles ?? 0,
          combo: { ...combo, version: 1 },
          comboSource: row.comboSource,
          comboReason: row.comboReason,
          wilsonLow: row.report.principal.wilsonLow,
          breakEven: row.report.breakEven,
          sample: row.report.principal.alvos + row.report.principal.stops,
          magnetTouches: row.report.toquesNoIma?.[24] ?? null,
          regime: regime ?? null,
        }
      : undefined,
    starsAtCreate: row.report?.estrelas,
    scoreAtCreate: row.report?.pontuacao,
    stake: bankroll.stake,
    leverage: bankroll.leverage,
    stakeCurrency: bankroll.currency,
    displayCurrency: bankroll.currency,
    fxAtCreate: convertMoney(1, quote, bankroll.currency, usdtBrl) ?? undefined,
    combo: label,
    regimeAtCreate: regime,
  };
}

export type CycleResult = {
  scored: ScoredRow[];
  nextPick: string | null;
  regime: RegimeReading;
  /** Motivo quando nenhuma moeda foi liberada. */
  note: string | null;
  bet: (NewBetOpts & { symbol: string; combo: string }) | null;
  chosenRow: ScoredRow | null;
  /** Início da rodada (ms) — base da chave canônica do ciclo. */
  t: number;
  /** Pares com dados válidos / total do snapshot. */
  dataOk: number;
  dataTotal: number;
};

/** Dados de mercado de uma rodada, montados uma vez e compartilhados entre usuários. */
export type MarketSnapshot = {
  /** Início da rodada (ms). */
  t: number;
  pairs: SymbolInfo[];
  results: ({ ok: true; value: { prev: Candle[]; cur: Candle[]; fetchedAt: number } } | { ok: false; error: string })[];
  btc: Candle[];
  eth: Candle[];
};

/** Monta o snapshot. `incremental` reaproveita a hora corrente entre rodadas (nuvem). */
export async function buildMarketSnapshot(opts: { incremental?: boolean; signal?: AbortSignal | undefined } = {}): Promise<MarketSnapshot> {
  const { signal } = opts;
  const pairs = await fetchPairs();
  if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
  const t = Date.now();
  const curStart = Math.floor(t / HOUR_MS) * HOUR_MS;
  const cur = opts.incremental ? getCurrentHourIncremental : getCurrentHour;
  const results = await mapSettled(
    pairs,
    async (p) => {
      const c: Candle[] = await cur(p.symbol, curStart, Date.now(), signal);
      const prev: Candle[] = await getClosedHour(p.symbol, curStart - HOUR_MS, signal);
      return { prev, cur: c, fetchedAt: Date.now() };
    },
    () => {},
    signal,
  );
  const [btc, eth] = await Promise.all(
    ["BTCUSDT", "ETHUSDT"].map((s) => getMinuteCandles24h(s, Date.now(), signal).catch(() => [] as Candle[])),
  );
  return { t, pairs, results, btc: btc!, eth: eth! };
}

/**
 * Dado válido = velas não vazias, recentes (mesmo limite de "dados-velhos") e com
 * cobertura completa da hora (mesmo critério de "cobertura"). Só conta para dataOk;
 * não muda a seleção.
 */
export function hasValidData(window: readonly Candle[], fetchedAt: number, analysis: { complete: boolean }): boolean {
  const last = window[window.length - 1];
  if (!last) return false;
  if (fetchedAt - (last.time + 1000) > SUPREMO_MAX_AGE_MS) return false;
  return analysis.complete;
}

export async function runSupremoCycle(opts: {
  bets: readonly Bet[];
  bankroll: Bankroll;
  usdtBrl: number | null;
  livePrices?: Map<string, number> | undefined;
  place: boolean;
  /** Snapshot compartilhado (nuvem). Sem ele, busca os dados na hora (navegador). */
  snapshot?: MarketSnapshot | undefined;
  /** Cancelamento real: abortado, nada é gravado (trauma, penalidade, auditoria). */
  signal?: AbortSignal | undefined;
}): Promise<CycleResult> {
  const { bankroll, livePrices, signal } = opts;
  const snap = opts.snapshot ?? (await buildMarketSnapshot({ signal }));
  if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
  const { pairs, results, t } = snap;
  const traumaMap = readTrauma();
  const quoteOf = new Map(pairs.map((p) => [p.symbol, p.quote]));
  let validCount = 0;
  const rows = pairs.flatMap((p, i) => {
    const r = results[i];
    if (!r || !r.ok) return [];
    const from = r.value.fetchedAt - HOUR_MS;
    const window = [...r.value.prev, ...r.value.cur].filter((k) => k.time >= from);
    const analysis = analyzeWindow(window, from, HOUR_MS, BAND_PCT);
    if (hasValidData(window, r.value.fetchedAt, analysis)) validCount++;
    const price = livePrices?.get(p.symbol) ?? analysis.lastClose;
    const blocks =
      price != null
        ? liveBlocks({ analysis, candles: window, fetchedAt: r.value.fetchedAt, price, minRep: MIN_REPETICOES })
        : (["dados-velhos"] as const).slice();
    const tr = applyTrauma(traumaMap, { symbol: p.symbol, candles: window, now: r.value.fetchedAt, coverage: analysis.coverage, blocks });
    const rise5m = changeOver(window, 5 * 60_000, r.value.fetchedAt);
    const ch15 = changeOver(window, 15 * 60_000, r.value.fetchedAt);
    const row: SelectionRow & { quote: string; analysis: ReturnType<typeof analyzeWindow>; rise5m: number | null; ch15: number | null } =
      { symbol: p.symbol, quote: p.quote, analysis, price, blocks: tr.blocks, rise5m, ch15 } as never;
    return [row];
  });

  // Efeitos (trauma, penalidade, auditoria) ficam em memória até o fim do trabalho assíncrono.
  if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
  const reg = readRegime({ btc: snap.btc, eth: snap.eth, universe15: rows.map((r) => r.ch15), now: Date.now() });
  const exposure = readExposure();
  const scoredRaw = await scoreRows(rows, comboResolver(), Date.now(), signal);
  const nowP = Date.now();
  const penSnap: Record<string, Penalty> = {};
  const scoredRows = scoredRaw.map((r) => {
    const extra = protectionBlocks(opts.bets, r, reg.regime, nowP).blocks;
    const rise = rows.find((x) => x.symbol === r.symbol)?.rise5m;
    if (rise != null && rise > 0.003) extra.push("perseguindo-alta");
    if (r.plan && repeatedOpportunity(opts.bets as Bet[], opportunityKey(r.symbol, r.plan.target, comboLabel(r.combo.targetPct, r.combo.stopPct, r.combo.mode)), nowP))
      extra.push("oportunidade-repetida");
    const pen = coinPenalty(opts.bets as Bet[], r.symbol, nowP);
    if (pen) penSnap[r.symbol] = pen;
    const blocks = [...r.blocks, ...extra.filter((b) => !r.blocks.includes(b))];
    return { ...r, blocks };
  });
  // Última verificação: daqui em diante só há escrita síncrona, nada mais pode abortar.
  if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
  writeTrauma(traumaMap);
  writePenaltySnapshot(penSnap);
  const { chosen, coins } = selectCoin(scoredRows, (s) => {
    const c = scoredRows.find((x) => x.symbol === s)!.combo;
    return exposureBlock(opts.bets as Bet[], s, comboLabel(c.targetPct, c.stopPct, c.mode), exposure, nowP);
  });
  const scored = scoredRows.filter((r) => r.report).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const dataTotal = pairs.length;
  const dataOk = validCount;
  const base = { scored, nextPick: chosen?.symbol ?? null, regime: reg, t, dataOk, dataTotal };
  if (!opts.place) return { ...base, note: null, bet: null, chosenRow: null };
  const cycleId = newId();
  // Dados incompletos (rede/corretora): bloqueia a aposta e diz o motivo real, em vez de "sem sinal".
  if (dataTotal === 0 || dataOk / dataTotal < MIN_DATA_FRACTION) {
    const note = `Dados inválidos ou incompletos: ${dataOk} de ${dataTotal} moedas com dados válidos — aposta bloqueada.`;
    appendAudit({ id: cycleId, at: t, chosen: null, note, coins: [], regime: reg.regime });
    return { ...base, note, bet: null, chosenRow: null };
  }
  if (!chosen) {
    const counts = new Map<string, number>();
    for (const c of coins) {
      for (const b of c.blocks) counts.set(b, (counts.get(b) ?? 0) + 1);
      if (c.exposure) { const k = exposureMotivo(c.exposure); counts.set(k, (counts.get(k) ?? 0) + 1); }
    }
    const summary = [...counts.entries()].map(([k, n]) => `${k} (${n})`).join(", ");
    const note = `Nenhuma moeda liberada no último ciclo${summary ? ` — ${summary}` : ""}.`;
    appendAudit({ id: cycleId, at: t, chosen: null, note, coins, regime: reg.regime });
    return { ...base, note, bet: null, chosenRow: null };
  }
  const row = scoredRows.find((r) => r.symbol === chosen.symbol)!;
  appendAudit({ id: cycleId, at: t, chosen: row.symbol, note: null, coins, regime: reg.regime });
  const bet = betOptsFromRow(row, quoteOf.get(row.symbol) ?? "USDT", bankroll, opts.usdtBrl, reg.regime);
  return { ...base, note: null, bet, chosenRow: row };
}
