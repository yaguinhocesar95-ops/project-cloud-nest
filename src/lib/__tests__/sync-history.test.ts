import { describe, expect, it } from "vitest";
import { resolveScalar } from "@/lib/sync-resolve";
import { aggregateDays, netPct, summarizeDay } from "@/lib/daily-stats";
import { applyCandleOfficial, closedCandles, compareResolutions, stepCandleShadow } from "@/lib/candle-resolution";
import { mergeBets } from "@/lib/bet-engine";
import type { Bet } from "@/hooks/useBets";

const base = { localRaw: '"a"', lastSynced: '"a"', localChangedAt: 0, remote: "a", remoteUpdatedAt: 100, lastSyncAt: 200, cloudOwns: false };

describe("resolveScalar", () => {
  it("só o navegador mudou: local", () => expect(resolveScalar({ ...base, localRaw: '"b"' })).toBe("local"));
  it("só a nuvem mudou: nuvem", () => expect(resolveScalar({ ...base, remote: "c", remoteUpdatedAt: 300 })).toBe("remote"));
  it("os dois mudaram: o mais recente vence", () => {
    expect(resolveScalar({ ...base, localRaw: '"b"', localChangedAt: 400, remote: "c", remoteUpdatedAt: 300 })).toBe("local");
    expect(resolveScalar({ ...base, localRaw: '"b"', localChangedAt: 250, remote: "c", remoteUpdatedAt: 300 })).toBe("remote");
  });
  it("nuvem dona: sempre nuvem", () => expect(resolveScalar({ ...base, localRaw: '"b"', localChangedAt: 999, cloudOwns: true })).toBe("remote"));
  it("sem valor na nuvem: local", () => expect(resolveScalar({ ...base, remote: null })).toBe("local"));
});

const bet = (o: Partial<Bet>): Bet => ({ id: "x", symbol: "AUSDT", status: "win", entryPrice: 100, target: 101, stop: 99, triggerPrice: 100, priceAtCreate: 99.5, createdAt: 0, events: [], ...o }) as Bet;

describe("daily stats", () => {
  it("resume vitórias, derrotas e líquido por moeda", () => {
    const s = summarizeDay("2026-10-11", [bet({}), bet({ status: "loss" }), bet({ status: "cancelled", symbol: "B" })]);
    expect(s).toMatchObject({ bets: 3, wins: 1, losses: 1 });
    expect(s.net_pct).toBeCloseTo(netPct(bet({})) + netPct(bet({ status: "loss" })));
    expect(s.by_coin["AUSDT"]).toMatchObject({ wins: 1, losses: 1 });
  });
  it("agrega dias", () => {
    expect(aggregateDays([{ wins: 7, losses: 3, net_pct: 0.01 }, { wins: 0, losses: 0, net_pct: 0 }])).toMatchObject({ n: 10, hitRate: 0.7, expectancy: 0.001 });
  });
});

const k = (time: number, low: number, high: number) => ({ time, open: low, high, low, close: high });

describe("resolução por vela", () => {
  const b = { createdAt: 10_000, priceAtCreate: 99.5, triggerPrice: 100, target: 101, stop: 99 };
  it("arma no gatilho e vence na vela seguinte que toca o alvo", () => {
    const s = stepCandleShadow(b, undefined, [k(10_000, 99.6, 100.1), k(11_000, 100, 101.2)]);
    expect(s).toMatchObject({ status: "win", armedAt: 10_000, at: 12_000 });
  });
  it("mesma vela tocando alvo e stop: derrota", () => {
    const s = stepCandleShadow(b, undefined, [k(10_000, 99.6, 100.1), k(11_000, 98.9, 101.2)]);
    expect(s.status).toBe("loss");
  });
  it("ignora vela em andamento e não relê velas", () => {
    expect(closedCandles([k(0, 1, 1), k(1000, 1, 1)], 1500)).toHaveLength(1);
    const s1 = stepCandleShadow(b, undefined, [k(10_000, 99.6, 100.1)]);
    const s2 = stepCandleShadow(b, s1, [k(10_000, 98, 102)]);
    expect(s2.status).toBe("open");
  });
  it("aplica na aposta oficial e compara", () => {
    const open = bet({ status: "open", armedAt: 1 });
    const done = applyCandleOfficial(open, { status: "loss", armedAt: 1, at: 5000, lastCandleAt: 4000 });
    expect(done).toMatchObject({ status: "loss", resolvedAt: 5000 });
    const cmp = compareResolutions([bet({ candleShadow: { status: "loss", armedAt: 1, at: 2, lastCandleAt: 1 } }), bet({ id: "y", candleShadow: { status: "win", armedAt: 1, at: 2, lastCandleAt: 1 } })]);
    expect(cmp).toMatchObject({ both: 2, agree: 1, price: { wins: 2 }, candle: { wins: 1, losses: 1 } });
  });
  it("mergeBets mantém a sombra mais avançada no empate", () => {
    const a = bet({ status: "open", candleShadow: { status: "open", armedAt: 1, at: null, lastCandleAt: 5 } });
    const c = { ...a, candleShadow: { status: "open" as const, armedAt: 1, at: null, lastCandleAt: 9 } };
    expect(mergeBets([a], [c])[0]!.candleShadow!.lastCandleAt).toBe(9);
  });
});
