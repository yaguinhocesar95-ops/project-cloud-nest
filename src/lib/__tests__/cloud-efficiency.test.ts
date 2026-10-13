import { describe, expect, it } from "vitest";
import { mergeBets, supremoBetId } from "@/lib/bet-engine";
import { runLimited } from "@/lib/run-limited";
import { mergeIncremental } from "@/lib/supremo-data";
import { safeEqual } from "@/lib/cron-auth.server";
import { isExternal } from "@/lib/fetch-counter";
import type { Bet } from "@/hooks/useBets";

const c = (time: number, close = 1) => ({ time, open: close, high: close, low: close, close });

describe("supremoBetId", () => {
  it("é igual para o mesmo usuário, minuto, moeda e combo", () => {
    const a = supremoBetId("u1", 60_000 * 10 + 5, "BTCUSDT", "0,5% / 0,5%");
    const b = supremoBetId("u1", 60_000 * 10 + 59_000, "BTCUSDT", "0,5% / 0,5%");
    expect(a).toBe(b);
    expect(supremoBetId("u1", 60_000 * 11, "BTCUSDT", "0,5% / 0,5%")).not.toBe(a);
    expect(supremoBetId("u2", 60_000 * 10, "BTCUSDT", "0,5% / 0,5%")).not.toBe(a);
  });
  it("mergeBets deduplica duas rodadas que geraram o mesmo id", () => {
    const id = supremoBetId("u1", 0, "ETHUSDT", "x");
    const bet = { id, createdAt: 1, symbol: "ETHUSDT", status: "pending" } as unknown as Bet;
    expect(mergeBets([bet], [{ ...bet }])).toHaveLength(1);
  });
});

describe("runLimited", () => {
  it("respeita o limite de simultâneos", async () => {
    let live = 0, peak = 0;
    const { done, deferred } = await runLimited([1, 2, 3, 4, 5, 6, 7], 3, Infinity, async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    });
    expect(peak).toBe(3);
    expect(done).toHaveLength(7);
    expect(deferred).toHaveLength(0);
  });
  it("marca como adiados os que passaram do prazo", async () => {
    let t = 0;
    const { done, deferred } = await runLimited(["a", "b", "c", "d"], 1, 2, async () => { t++; }, () => t);
    expect(done).toEqual(["a", "b"]);
    expect(deferred).toEqual(["c", "d"]);
  });
});

describe("mergeIncremental", () => {
  it("troca a última vela antiga pela nova e acrescenta as seguintes", () => {
    const out = mergeIncremental([c(0), c(1000), c(2000, 1)], [c(2000, 2), c(3000)]);
    expect(out.map((k) => k.time)).toEqual([0, 1000, 2000, 3000]);
    expect(out[2]!.close).toBe(2);
  });
  it("sem velas novas mantém o cache", () => {
    expect(mergeIncremental([c(0)], [])).toEqual([c(0)]);
  });
});

describe("cron auth", () => {
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abd", "abc")).toBe(false);
    expect(safeEqual("ab", "abc")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
  it("isExternal ignora o próprio banco", () => {
    expect(isExternal("https://db.example.co/rest/v1/x", "db.example.co")).toBe(false);
    expect(isExternal("https://api-gcp.binance.com/api/v3/klines", "db.example.co")).toBe(true);
  });
});
