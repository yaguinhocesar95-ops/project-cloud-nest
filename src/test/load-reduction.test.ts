// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPairs, _resetPairsCache, PAIRS_TTL_MS } from "@/lib/binance";

const body = JSON.stringify([{ symbol: "BTCUSDT", lastPrice: "1", quoteVolume: "5", priceChangePercent: "0" }]);
describe("lista de moedas compartilhada no navegador", () => {
  beforeEach(() => { _resetPairsCache(); vi.restoreAllMocks(); });
  it("pedidos simultâneos e dentro do TTL viram uma única busca", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body));
    await Promise.all([fetchPairs(), fetchPairs(), fetchPairs()]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("depois do TTL busca de novo", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await fetchPairs();
    now.mockReturnValue(1_000_000 + PAIRS_TTL_MS + 1);
    await fetchPairs();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("falha não fica em cache", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("rede")).mockImplementation(async () => new Response(body));
    await expect(fetchPairs()).rejects.toThrow();
    await fetchPairs();
    expect(f).toHaveBeenCalledTimes(2);
  });
});
