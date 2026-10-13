import { describe, expect, it, vi } from "vitest";
import type { Candle } from "../replay";
import { DEFAULT_COMBO } from "../supremo-combo";
import {
  PROFILES_VERSION,
  comboForSymbol,
  decideProfile,
  independentEpisodes,
  opportunityKey,
  repeatedOpportunity,
  type ComboProfile,
  type ProfileStore,
} from "../supremo-combo-profiles";
import { planCombo, type LabCandidate } from "../target-stop-lab";

vi.mock("@/lib/supremo-data", () => ({ getMinuteCandles24h: async () => [], mapSettled: async () => [] }));

const H = 3_600_000;
const c = (time: number, low: number, high: number): Candle => ({ time, open: low, high, low, close: (low + high) / 2, volume: 1 }) as Candle;
const cand = (symbol: string, hourStart: number, candles: Candle[] = []): LabCandidate => ({
  id: `${symbol}-${hourStart}`, symbol, hourStart, magnet: 101, priceAtCreate: 102, regime: "normal", fee: 0.002, spread: null, candles,
});

const profile = (symbol: string, targetPct: number, stopPct: number): ComboProfile => {
  const t = { executed: 40, hitRate: 0.8, wilsonLow: 0.65, breakeven: 0.6, expectancy: 0.001, expectancyWilsonLow: 0.0002, totalReturn: 0.04, profitFactor: 2, maxDrawdown: 0.01 };
  return { symbol, combo: { targetPct, stopPct, mode: "percentual" }, evidence: "moderada", episodes: 60, trainSize: 30, testSize: 30, train: t, test: t, globalTest: t, reason: "ok", createdAt: 0, version: PROFILES_VERSION };
};

describe("combinação por moeda", () => {
  const store: ProfileStore = { enabled: true, profiles: { AAAUSDT: profile("AAAUSDT", 0.004, 0.006) }, computedAt: 0 };

  it("moedas diferentes podem usar combos diferentes", () => {
    expect(comboForSymbol("AAAUSDT", store, DEFAULT_COMBO).combo.targetPct).toBe(0.004);
    expect(comboForSymbol("BBBUSDT", store, DEFAULT_COMBO).combo).toEqual(DEFAULT_COMBO);
    expect(comboForSymbol("BBBUSDT", store, DEFAULT_COMBO).reason).toMatch(/amostra insuficiente — usando combo global/);
  });

  it("modo desligado usa sempre a global", () => {
    expect(comboForSymbol("AAAUSDT", { ...store, enabled: false }, DEFAULT_COMBO).source).toBe("global");
  });

  it("perfil de versão antiga é ignorado", () => {
    const old = { ...store, profiles: { AAAUSDT: { ...profile("AAAUSDT", 0.004, 0.006), version: 0 } } };
    expect(comboForSymbol("AAAUSDT", old, DEFAULT_COMBO).source).toBe("global");
  });

  it("pouca amostra → fallback global, sem perfil próprio", () => {
    const cands = Array.from({ length: 20 }, (_, i) => cand("X", i * H));
    const d = decideProfile("X", cands, [0.004, 0.005], [0.004, 0.005], "percentual", DEFAULT_COMBO);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toMatch(/amostra insuficiente/);
  });

  it("sinais repetidos na mesma hora contam como um episódio", () => {
    const cands = [cand("X", 0), cand("X", 0), cand("X", H), cand("Y", 0)];
    expect(independentEpisodes(cands)).toHaveLength(3);
    const d = decideProfile("X", Array.from({ length: 40 }, () => cand("X", 0)), [0.005], [0.005], "percentual", DEFAULT_COMBO);
    expect(d.ok).toBe(false); // 40 sinais, 1 episódio
  });

  it("combo que não supera a global fora da amostra é rejeitado", () => {
    // Todos ganham em qualquer combo: a melhor do treino não supera a global no teste de forma real.
    const mk = (i: number) => {
      const p = planCombo(101, 0.0055, 0.0055, "percentual");
      return cand("X", i * H, [c(i * H, p.trigger - 0.5, p.trigger), c(i * H + 1000, p.trigger, 101.5)]);
    };
    const cands = Array.from({ length: 60 }, (_, i) => mk(i));
    const d = decideProfile("X", cands, [0.0055], [0.0055], "percentual", DEFAULT_COMBO);
    expect(d.ok).toBe(false);
  });

  it("não repete a mesma oportunidade (moeda+ímã+combo) dentro do cooldown", () => {
    const k = opportunityKey("X", 101, "A");
    const bets = [{ symbol: "X", target: 101.01, combo: "A", createdAt: 1_000 }];
    expect(repeatedOpportunity(bets, k, 1_000 + 60_000)).toBe(true);
    expect(repeatedOpportunity(bets, k, 1_000 + 31 * 60_000)).toBe(false);
    expect(repeatedOpportunity(bets, opportunityKey("X", 101, "B"), 61_000)).toBe(false);
  });
});

describe("snapshot da aposta", () => {
  it("usa o combo da linha pontuada, não relê a global", async () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
    };
    const { betOptsFromRow } = await import("../supremo-cycle");
    localStorage.setItem("supremo-active-combo-v1", JSON.stringify({ targetPct: 0.009, stopPct: 0.009, mode: "percentual" }));
    const combo = { targetPct: 0.004, stopPct: 0.006, mode: "percentual" as const };
    const plan = planCombo(101, 0.004, 0.006, "percentual");
    const row = {
      symbol: "X", price: 102, quote: "USDT", blocks: [], analysis: { index: 5, top: { center: 101 } } as never, plan, report: null,
      combo, comboSource: "perfil" as const, comboReason: "ok",
    } as never;
    const o = betOptsFromRow(row, "USDT", { stake: 10, leverage: 1, currency: "USDT" } as never, null, "normal")!;
    expect(o.combo).toContain("0,40");
    expect(o.stop).toBeCloseTo(plan.stop, 10);
    localStorage.removeItem("supremo-active-combo-v1");
  });
});
