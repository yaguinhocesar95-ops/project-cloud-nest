// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { classifyError, classifyResult, isFailure } from "@/lib/cycle-status";
import { isExpiredKey, RETENTION_MS } from "@/lib/supremo-data";
import { HOUR_MS } from "@/lib/supremo";

describe("estado da rodada", () => {
  it("separa sem sinal de dados inválidos", () => {
    expect(classifyResult({ place: true, dataOk: 50, dataTotal: 60, note: "x", chosen: false })).toBe("sem-sinal");
    expect(classifyResult({ place: true, dataOk: 5, dataTotal: 60, note: "x", chosen: false })).toBe("dados-invalidos");
    expect(classifyResult({ place: true, dataOk: 0, dataTotal: 0, note: null, chosen: false })).toBe("dados-invalidos");
    expect(classifyResult({ place: true, dataOk: 60, dataTotal: 60, note: null, chosen: true })).toBe("aposta-aceita");
    expect(isFailure("sem-sinal")).toBe(false);
    expect(isFailure("dados-invalidos")).toBe(true);
  });
  it("classifica erros", () => {
    expect(classifyError(new Error("ciclo demorou demais"))).toBe("falha-tempo");
    expect(classifyError(new TypeError("Failed to fetch"))).toBe("falha-rede");
    expect(classifyError(new DOMException("cancelado", "AbortError"))).toBe("cancelada");
  });
});

describe("retenção do cache local", () => {
  const now = 1_800_000_000_000;
  it("expira só chaves vencidas e conhecidas", () => {
    expect(isExpiredKey(`BTCUSDT:${now - RETENTION_MS.hour - 1}`, now)).toBe(true);
    expect(isExpiredKey(`BTCUSDT:${now - HOUR_MS}`, now)).toBe(false);
    expect(isExpiredKey(`m1:BTCUSDT:${now - 3 * HOUR_MS}`, now)).toBe(true);
    expect(isExpiredKey(`m1:BTCUSDT:${now - HOUR_MS}`, now)).toBe(false);
    expect(isExpiredKey(`m1d:BTCUSDT:${now - 7 * 24 * HOUR_MS}`, now)).toBe(false);
    expect(isExpiredKey(`m1d:BTCUSDT:${now - 9 * 24 * HOUR_MS}`, now)).toBe(true);
    expect(isExpiredKey("config", now)).toBe(false);
    expect(isExpiredKey("x:abc", now)).toBe(false);
  });
  it("crescimento limitado ao longo de vários dias", () => {
    // simula 10 dias de chaves m1 horárias + horas fechadas de 1 par
    const keys: string[] = [];
    for (let h = 0; h < 240; h++) {
      const t = now - h * HOUR_MS;
      keys.push(`m1:BTCUSDT:${t}`, `BTCUSDT:${t}`);
    }
    const kept = keys.filter((k) => !isExpiredKey(k, now));
    expect(kept.length).toBeLessThanOrEqual(3 + 49);
  });
});

describe("preço ao vivo: websocket mudo reconecta", () => {
  it("fecha o socket silencioso e reabre", async () => {
    vi.useFakeTimers();
    const sockets: FakeWS[] = [];
    class FakeWS {
      static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((e: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { sockets.push(this); setTimeout(() => this.onopen?.(), 0); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    vi.stubGlobal("WebSocket", FakeWS);
    let restCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("ticker/price")) {
        restCalls++;
        return new Response(JSON.stringify({ price: "100" }));
      }
      return new Response("[]");
    }));
    const { renderHook, act } = await import("@testing-library/react");
    const { useLivePrice, WS_DEAD_MS } = await import("@/hooks/useLivePrice");
    const { result, unmount } = renderHook(() => useLivePrice("BTCUSDT"));
    await act(async () => { await vi.advanceTimersByTimeAsync(WS_DEAD_MS + 5_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(sockets.length).toBeGreaterThanOrEqual(2); // reconectou
    expect(restCalls).toBeGreaterThan(0); // REST cobriu o silêncio
    expect(result.current.price).toBe(100); // preço recuperado
    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
