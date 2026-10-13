import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { backoffMs, fetchSpotPrices, fetchWithTimeout } from "@/lib/history-seed";
import { withAbortTimeout } from "@/hooks/useSupremoAuto";

afterEach(() => vi.restoreAllMocks());

describe("preservação de dados", () => {
  it("o app não apaga localStorage, sessionStorage nem IndexedDB ao abrir", () => {
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).not.toMatch(/localStorage\.clear|sessionStorage\.clear|deleteDatabase/);
  });
});

describe("fetch com timeout", () => {
  it("aborta após o tempo-limite", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("abort")))),
    );
    await expect(fetchWithTimeout("x", undefined, 20)).rejects.toThrow();
  });
  it("propaga cancelamento externo", async () => {
    const ctl = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_, rej) => init!.signal!.addEventListener("abort", () => rej(new Error("abort")))),
    );
    const p = fetchWithTimeout("x", ctl.signal, 10_000);
    ctl.abort();
    await expect(p).rejects.toThrow();
  });
  it("backoff é limitado", () => {
    for (let i = 0; i < 30; i++) expect(backoffMs(i, 400, 30_000)).toBeLessThanOrEqual(30_000);
  });
});

describe("lote restrito de preços", () => {
  it("pede só os pares ativos e cai para a lista completa em 400", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
      urls.push(String(u));
      if (String(u).includes("symbols=")) return new Response("", { status: 400 });
      return new Response(JSON.stringify([{ symbol: "BTCUSDT", price: "1" }, { symbol: "X", price: "2" }]));
    });
    const out = await fetchSpotPrices(["BTCUSDT"]);
    expect(urls[0]).toContain("symbols=");
    expect(out.get("BTCUSDT")).toBe(1);
    expect(out.has("X")).toBe(false);
  });
});

describe("ciclo cancelável", () => {
  it("timeout aborta o sinal do trabalho real", async () => {
    let seen: AbortSignal | null = null;
    await expect(
      withAbortTimeout((s) => { seen = s; return new Promise(() => {}); }, 20),
    ).rejects.toBeTruthy();
    expect(seen!.aborted).toBe(true);
  });
});
