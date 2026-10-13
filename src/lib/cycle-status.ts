/**
 * Estado explícito da última rodada Supremo. Separa "sem sinal" (rodou, dados
 * bons, nenhuma moeda liberada) de "falha" (rede, tempo esgotado, dados
 * inválidos), para o painel nunca parecer saudável sem estar — nem parado só
 * porque não houve sinal.
 */
export type CyclePhase =
  | "rodando"
  | "ignorada-trava"
  | "cancelada"
  | "falha-rede"
  | "falha-tempo"
  | "falha"
  | "dados-invalidos"
  | "analise"
  | "sem-sinal"
  | "aposta-aceita"
  | "aposta-bloqueada";

export type CycleStatus = {
  phase: CyclePhase;
  at: number;
  detail: string | null;
  /** Pares analisados com dados válidos / total. */
  dataOk?: number;
  dataTotal?: number;
  /** Última rodada que terminou sem falha (com ou sem aposta). */
  lastSuccessAt: number | null;
};

/** Fração mínima de pares com dados válidos para a rodada contar como confiável. */
export const MIN_DATA_FRACTION = 0.5;

export function isFailure(p: CyclePhase): boolean {
  return p === "falha" || p === "falha-rede" || p === "falha-tempo" || p === "dados-invalidos";
}

/** Classifica o fim de uma rodada a partir do resultado do ciclo. */
export function classifyResult(r: {
  place: boolean;
  dataOk: number;
  dataTotal: number;
  note: string | null;
  chosen: boolean;
}): CyclePhase {
  if (r.dataTotal === 0 || r.dataOk / r.dataTotal < MIN_DATA_FRACTION) return "dados-invalidos";
  if (!r.place) return "analise";
  if (r.chosen) return "aposta-aceita"; // o chamador rebaixa para bloqueada se o registro recusar
  return "sem-sinal";
}

export function classifyError(e: unknown): CyclePhase {
  const err = e as { name?: string; message?: string } | null;
  const msg = err?.message ?? String(e);
  if (/demorou demais|timeout/i.test(msg)) return "falha-tempo";
  if (err?.name === "AbortError" || /cancelado/.test(msg)) return "cancelada";
  if (/fetch|network|Failed|rede/i.test(msg)) return "falha-rede";
  return "falha";
}

export const PHASE_LABEL: Record<CyclePhase, string> = {
  rodando: "Rodada em andamento",
  "ignorada-trava": "Rodada adiada: outra ainda em andamento",
  cancelada: "Rodada cancelada",
  "falha-rede": "Falha: corretora indisponível",
  "falha-tempo": "Falha: tempo esgotado",
  falha: "Falha na rodada",
  "dados-invalidos": "Dados inválidos ou incompletos — apostas bloqueadas",
  analise: "Análise atualizada",
  "sem-sinal": "Rodada concluída: sem sinal",
  "aposta-aceita": "Rodada concluída: aposta registrada",
  "aposta-bloqueada": "Rodada concluída: aposta bloqueada",
};
