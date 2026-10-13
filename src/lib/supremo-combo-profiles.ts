/**
 * Perfis de alvo/stop por moeda (Supremo). Só cria perfil próprio quando a
 * moeda tem episódios independentes suficientes e a combinação escolhida
 * APENAS no passado (treino) se sustenta no período seguinte intocado (teste).
 * Sem isso, a moeda usa a combinação global. Afeta só apostas novas.
 */
import { readActiveCombo, type ActiveCombo } from "./supremo-combo";
import {
  LAB_MIN_SAMPLE,
  LAB_STRONG_SAMPLE,
  comboLabel,
  evaluateCombo,
  evaluateGrid,
  rankCombos,
  splitWalkForward,
  stabilityOf,
  type ComboStats,
  type LabCandidate,
  type LabMode,
} from "./target-stop-lab";

export const PROFILES_KEY = "supremo-combo-by-symbol-v1";
export const PROFILES_VERSION = 1;

export type Evidence = "forte" | "moderada";

export type TestSummary = {
  executed: number;
  hitRate: number | null;
  wilsonLow: number | null;
  breakeven: number | null;
  expectancy: number | null;
  expectancyWilsonLow: number | null;
  totalReturn: number;
  profitFactor: number | null;
  maxDrawdown: number;
};

export type ComboProfile = {
  symbol: string;
  combo: ActiveCombo;
  evidence: Evidence;
  /** Episódios independentes (1 por moeda por hora). */
  episodes: number;
  trainSize: number;
  testSize: number;
  train: TestSummary;
  test: TestSummary;
  /** Mesmo período de teste com a combinação global, para comparar. */
  globalTest: TestSummary;
  reason: string;
  createdAt: number;
  version: number;
};

export type ProfileDecision =
  | { symbol: string; ok: true; profile: ComboProfile }
  | { symbol: string; ok: false; episodes: number; reason: string };

export type ProfileStore = { enabled: boolean; profiles: Record<string, ComboProfile>; computedAt: number | null };

const EMPTY: ProfileStore = { enabled: false, profiles: {}, computedAt: null };

export function readProfiles(): ProfileStore {
  if (typeof localStorage === "undefined") return EMPTY;
  try {
    const v = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? "null");
    if (v && typeof v === "object") return { enabled: !!v.enabled, profiles: v.profiles ?? {}, computedAt: v.computedAt ?? null };
  } catch {}
  return EMPTY;
}

export function writeProfiles(s: ProfileStore) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(s));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("supremo-combo"));
}

export type ResolvedCombo = { combo: ActiveCombo; source: "perfil" | "global"; reason: string; evidence?: Evidence };

/** Combinação que a moeda usa nas próximas apostas. */
export function comboForSymbol(symbol: string, store: ProfileStore = readProfiles(), global: ActiveCombo = readActiveCombo()): ResolvedCombo {
  if (!store.enabled) return { combo: global, source: "global", reason: "combinação por moeda desligada" };
  const p = store.profiles[symbol];
  if (!p || p.version !== PROFILES_VERSION) return { combo: global, source: "global", reason: "amostra insuficiente — usando combo global" };
  return { combo: p.combo, source: "perfil", reason: p.reason, evidence: p.evidence };
}

export function comboResolver(store: ProfileStore = readProfiles(), global: ActiveCombo = readActiveCombo()) {
  return (symbol: string) => comboForSymbol(symbol, store, global);
}

/** Um episódio por moeda por hora: sinais repetidos da mesma hora não contam como amostras novas. */
export function independentEpisodes(cands: readonly LabCandidate[]): LabCandidate[] {
  const seen = new Set<string>();
  return [...cands]
    .sort((a, b) => a.hourStart - b.hourStart)
    .filter((c) => {
      const k = `${c.symbol}|${c.hourStart}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/** Resumo com fator de lucro e drawdown (sequência temporal). */
export function summarize(cands: readonly LabCandidate[], s: ComboStats, mode: LabMode): TestSummary {
  // Recalcula a curva para profit factor / drawdown na ordem do tempo.
  let gp = 0, gl = 0, eq = 0, peak = 0, dd = 0;
  for (const c of [...cands].sort((a, b) => a.hourStart - b.hourStart)) {
    const one = evaluateCombo([c], s.targetPct, s.stopPct, mode);
    if (one.executed === 0) continue;
    const r = one.totalReturn;
    if (r >= 0) gp += r; else gl -= r;
    eq += r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  return {
    executed: s.executed,
    hitRate: s.hitRate,
    wilsonLow: s.wilson?.low ?? null,
    breakeven: s.breakeven,
    expectancy: s.expectancy,
    expectancyWilsonLow: s.expectancyWilsonLow,
    totalReturn: s.totalReturn,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    maxDrawdown: dd,
  };
}

/**
 * Decide o perfil de UMA moeda. Seleção só no treino (primeira metade do
 * tempo); a decisão depende do teste (segunda metade), que a seleção nunca viu.
 */
export function decideProfile(
  symbol: string,
  candsAll: readonly LabCandidate[],
  targets: readonly number[],
  stops: readonly number[],
  mode: LabMode,
  global: ActiveCombo,
  now = Date.now(),
): ProfileDecision {
  const cands = independentEpisodes(candsAll.filter((c) => c.symbol === symbol));
  const n = cands.length;
  const fail = (reason: string): ProfileDecision => ({ symbol, ok: false, episodes: n, reason });
  if (n < LAB_MIN_SAMPLE) return fail(`amostra insuficiente (${n} episódios < ${LAB_MIN_SAMPLE}) — usando combo global`);
  const { first, second } = splitWalkForward(cands);
  const trainStats = evaluateGrid(first, targets, stops, mode);
  const ranked = rankCombos(trainStats, Math.max(5, Math.floor(LAB_MIN_SAMPLE / 2)));
  const best = ranked[0];
  if (!best) return fail("nenhuma combinação com execuções suficientes no treino — usando combo global");
  const stab = stabilityOf(best, trainStats, targets, stops);
  if (stab.overfit) return fail("melhor combinação do treino é um pico isolado na grade (overfit) — usando combo global");
  const test = evaluateCombo(second, best.targetPct, best.stopPct, mode);
  const gTest = evaluateCombo(second, global.targetPct, global.stopPct, global.mode);
  const minTest = n >= LAB_STRONG_SAMPLE ? 30 : 15;
  if (test.executed < minTest) return fail(`teste fora da amostra com só ${test.executed} execuções (< ${minTest}) — usando combo global`);
  if ((test.expectancy ?? -1) <= 0) return fail("expectativa líquida ≤ 0 no teste fora da amostra — usando combo global");
  const evidence: Evidence = n >= LAB_STRONG_SAMPLE ? "forte" : "moderada";
  // Moderada exige o critério pessimista (Wilson) acima de zero; forte exige superar o global no teste.
  if (evidence === "moderada" && (test.expectancyWilsonLow ?? -1) <= 0)
    return fail("evidência moderada sem expectativa pessimista positiva no teste — usando combo global");
  if ((gTest.expectancy ?? -Infinity) >= (test.expectancy ?? -Infinity))
    return fail("não superou a combinação global no período de teste — usando combo global");
  const combo: ActiveCombo = { targetPct: best.targetPct, stopPct: best.stopPct, mode };
  return {
    symbol,
    ok: true,
    profile: {
      symbol,
      combo,
      evidence,
      episodes: n,
      trainSize: first.length,
      testSize: second.length,
      train: summarize(first, best, mode),
      test: summarize(second, test, mode),
      globalTest: summarize(second, gTest, mode),
      reason: `${comboLabel(combo.targetPct, combo.stopPct, mode)} validada fora da amostra (evidência ${evidence}, ${n} episódios)`,
      createdAt: now,
      version: PROFILES_VERSION,
    },
  };
}

export function buildProfiles(
  cands: readonly LabCandidate[],
  targets: readonly number[],
  stops: readonly number[],
  mode: LabMode,
  global: ActiveCombo,
  now = Date.now(),
): ProfileDecision[] {
  const symbols = [...new Set(cands.map((c) => c.symbol))].sort();
  return symbols.map((s) => decideProfile(s, cands, targets, stops, mode, global, now));
}

/** Chave estável da oportunidade: moeda + faixa do ímã + combinação. */
export function opportunityKey(symbol: string, target: number, combo: string | undefined, bandPct = 0.001): string {
  const band = Math.floor(Math.log(target) / Math.log(1 + bandPct));
  return `${symbol}|${band}|${combo ?? ""}`;
}

export const OPPORTUNITY_COOLDOWN_MS = 30 * 60_000;

/** Já houve aposta (qualquer desfecho) na mesma oportunidade dentro do cooldown? */
export function repeatedOpportunity(
  bets: readonly { symbol: string; target: number; combo?: string | undefined; createdAt?: number }[],
  key: string,
  now: number,
  cooldown = OPPORTUNITY_COOLDOWN_MS,
): boolean {
  return bets.some((b) => b.createdAt != null && now - b.createdAt < cooldown && opportunityKey(b.symbol, b.target, b.combo) === key);
}
