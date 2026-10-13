import { describe, expect, it } from "vitest";
import { buildBet, mergeBets, supremoBetId } from "@/lib/bet-engine";

describe("ciclo Supremo idempotente", () => {
  it("nuvem e navegador no mesmo minuto/moeda/combo geram o mesmo id e o merge deixa uma aposta", () => {
    const t = Date.UTC(2026, 9, 13, 13, 27, 2);
    const cloud = supremoBetId("u1", t, "BTCUSDT", "+0.5 / -0.5");
    const browser = supremoBetId("u1", t + 20_000, "BTCUSDT", "+0.5/-0.5");
    expect(cloud).toBe(browser);
    const mk = (id: string) => buildBet({ id, symbol: "BTCUSDT", quote: "USDT", priceNow: 100, triggerPrice: 100, hitRate: 0, sampleSize: 0, stake: 1, leverage: 1, stakeCurrency: "USDT" } as never, null, "USDT", null, t)!;
    const merged = mergeBets([mk(cloud)], [mk(browser)]);
    expect(merged.filter((b) => b.id === cloud)).toHaveLength(1);
  });
  it("apostas manuais continuam com id próprio", () => {
    const a = buildBet({ symbol: "X", quote: "USDT", priceNow: 1, triggerPrice: 1, hitRate: 0, sampleSize: 0, stake: 1, leverage: 1, stakeCurrency: "USDT" } as never, null, "USDT", null, 0)!;
    const b = buildBet({ symbol: "X", quote: "USDT", priceNow: 1, triggerPrice: 1, hitRate: 0, sampleSize: 0, stake: 1, leverage: 1, stakeCurrency: "USDT" } as never, null, "USDT", null, 0)!;
    expect(a.id).not.toBe(b.id);
  });
});
