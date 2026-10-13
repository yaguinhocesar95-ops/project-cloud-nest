/**
 * Resolução "por vela": acompanha a aposta só com velas de 1 s JÁ FECHADAS.
 * Corre em paralelo à resolução por preço (sombra) para comparar as duas; só
 * vira a resolução oficial quando a opção "por vela" estiver ligada.
 * Regra mantida: a mesma vela tocando alvo e stop conta como derrota.
 */
import type { Bet } from "@/hooks/useBets";
import type { Candle } from "@/lib/replay";

export const RESOLVE_MODE_KEY = "ypx-resolve-mode";
export type ResolveMode = "price" | "candle";

export type CandleShadow = {
  status: "pending" | "open" | "win" | "loss";
  armedAt: number | null;
  at: number | null;
  /** Hora de início da última vela já considerada. */
  lastCandleAt: number;
};

export function parseResolveMode(v: unknown): ResolveMode {
  return v === "candle" ? "candle" : "price";
}

/** Só velas fechadas: a vela de 1 s precisa ter terminado antes de `fetchedAt`. */
export function closedCandles(candles: readonly Candle[], fetchedAt: number): Candle[] {
  return candles.filter((c) => c.time + 1000 <= fetchedAt);
}

/** Avança a sombra "por vela" com as velas fechadas novas. */
export function stepCandleShadow(
  bet: Pick<Bet, "createdAt" | "priceAtCreate" | "triggerPrice" | "target" | "stop">,
  prev: CandleShadow | undefined,
  closed: readonly Candle[],
): CandleShadow {
  const s: CandleShadow = prev ? { ...prev } : { status: "pending", armedAt: null, at: null, lastCandleAt: bet.createdAt - 1000 };
  if (s.status === "win" || s.status === "loss") return s;
  const up = bet.priceAtCreate <= bet.triggerPrice;
  for (const c of closed) {
    if (c.time <= s.lastCandleAt) continue;
    // Vela que começou antes do registro não conta (evita olhar para trás).
    if (c.time < bet.createdAt - 999) continue;
    s.lastCandleAt = c.time;
    if (s.status === "pending") {
      const touched = up ? c.high >= bet.triggerPrice : c.low <= bet.triggerPrice;
      if (touched) { s.status = "open"; s.armedAt = c.time; }
      // Não decide na mesma vela do gatilho: a ordem dentro dela é desconhecida.
      continue;
    }
    const hitT = c.high >= bet.target;
    const hitS = c.low <= bet.stop;
    if (hitS) { s.status = "loss"; s.at = c.time + 1000; break; }
    if (hitT) { s.status = "win"; s.at = c.time + 1000; break; }
  }
  return s;
}

/** Com a opção "por vela" ligada: aplica a decisão da sombra na aposta oficial. */
export function applyCandleOfficial(bet: Bet, s: CandleShadow): Bet {
  if (bet.status === "pending" && s.status !== "pending" && s.armedAt != null) {
    bet = {
      ...bet, status: "open", armedAt: s.armedAt, best: bet.triggerPrice, worst: bet.triggerPrice,
      events: [...(bet.events ?? []), { t: s.armedAt, type: "gatilho", price: bet.triggerPrice, note: "por vela" }, { t: s.armedAt, type: "entrada", price: bet.entryPrice }],
    };
  }
  if (bet.status === "open" && (s.status === "win" || s.status === "loss") && s.at != null) {
    const win = s.status === "win";
    const px = win ? bet.target : bet.stop;
    return {
      ...bet, status: s.status, resolvedAt: s.at, lastPrice: px, lastPriceAt: s.at,
      events: [...(bet.events ?? []), { t: s.at, type: win ? "alvo" : "stop", price: px, note: "por vela" }, { t: s.at, type: "encerrada", price: px }],
    };
  }
  return bet;
}

export type ResolutionComparison = {
  both: number;
  agree: number;
  price: { wins: number; losses: number; hitRate: number | null };
  candle: { wins: number; losses: number; hitRate: number | null };
};

/** Compara o desfecho por preço (oficial) com o desfecho por vela (sombra). */
export function compareResolutions(bets: readonly Bet[]): ResolutionComparison {
  let both = 0, agree = 0, pw = 0, pl = 0, cw = 0, cl = 0;
  for (const b of bets) {
    const s = b.candleShadow;
    const off = b.status === "win" || b.status === "loss" ? b.status : null;
    const sh = s && (s.status === "win" || s.status === "loss") ? s.status : null;
    if (!off || !sh) continue;
    both++;
    if (off === sh) agree++;
    if (off === "win") pw++; else pl++;
    if (sh === "win") cw++; else cl++;
  }
  const hr = (w: number, l: number) => (w + l ? w / (w + l) : null);
  return { both, agree, price: { wins: pw, losses: pl, hitRate: hr(pw, pl) }, candle: { wins: cw, losses: cl, hitRate: hr(cw, cl) } };
}
