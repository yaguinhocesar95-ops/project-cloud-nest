import { describe, it, expect } from "vitest";
import { probeSymbols, SERVER_UNIVERSE } from "@/lib/price-probe.server";
describe("conferência de preços da nuvem", () => {
  it("completa (10 moedas) a cada 5 minutos", () => { expect(probeSymbols(5 * 60_000)).toHaveLength(SERVER_UNIVERSE.length); });
  it("leve (BTC e SOL) nos outros minutos", () => { expect(probeSymbols(6 * 60_000)).toEqual(["BTCUSDT", "SOLUSDT"]); });
});
