/**
 * Fonte de dados de mercado do SERVIDOR (nuvem). O navegador usa sempre a Binance.
 * A nuvem fica numa região que a Binance bloqueia, então cada rodada escolhe UMA
 * corretora para o snapshot inteiro (pares, preços e velas) — nunca mistura.
 *
 * - okx: velas de 1 s e 1 min, pares e preços. Fonte principal.
 * - binance: só se algum endereço responder da nuvem.
 * - bybit: pares, preços e velas de 1 min. NÃO tem velas de 1 s, então a análise
 *   Supremo (que exige 1 s) fica sem moedas liberadas; serve para acompanhar as apostas.
 */
import type { Candle } from "./replay";

export type MarketSource = "binance" | "okx" | "bybit";
let SOURCE: MarketSource = "binance";
export function setMarketSource(s: MarketSource) {
  SOURCE = s;
}
export function getMarketSource(): MarketSource {
  return SOURCE;
}

export type SourcePair = { symbol: string; price: number; changePct: number; quoteVolume: number };

export const OKX_HOSTS = ["https://www.okx.com", "https://aws.okx.com"];
const BYBIT = "https://api.bybit.com";
const okxId = (s: string) => `${s.slice(0, -4)}-USDT`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// OKX: history-candles aceita 20 pedidos / 2 s por IP. Espaçamos e alternamos endereços.
let okxNext = 0;
let okxTurn = 0;
async function okxGet(path: string): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    const wait = okxNext - Date.now();
    okxNext = Math.max(Date.now(), okxNext) + 110;
    if (wait > 0) await sleep(wait);
    const host = OKX_HOSTS[okxTurn++ % OKX_HOSTS.length]!;
    try {
      const r = await timedFetch(`${host}${path}`, 10_000);
      if (r.status === 429 || r.status >= 500) throw new Error(`okx HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`okx HTTP ${r.status}`), { fatal: true });
      const j = (await r.json()) as { code: string; msg: string; data: unknown };
      if (j.code === "50011") throw new Error("okx limite de pedidos");
      if (j.code !== "0") throw Object.assign(new Error(`okx code ${j.code} ${j.msg}`), { fatal: true });
      return j.data;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || attempt >= 4) throw e;
      await sleep(300 * 2 ** attempt++ + Math.random() * 200);
    }
  }
}

async function bybitGet(path: string): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      const r = await timedFetch(`${BYBIT}${path}`, 10_000);
      if (!r.ok) throw Object.assign(new Error(`bybit HTTP ${r.status}`), { fatal: r.status < 500 && r.status !== 429 });
      const j = (await r.json()) as { retCode: number; retMsg: string; result: unknown };
      if (j.retCode !== 0) throw Object.assign(new Error(`bybit ${j.retCode} ${j.retMsg}`), { fatal: true });
      return j.result;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal || attempt >= 3) throw e;
      await sleep(300 * 2 ** attempt++ + Math.random() * 200);
    }
  }
}

function timedFetch(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(to));
}

/** Velas [start, end) da corretora indicada. */
export async function sourceRange(src: Exclude<MarketSource, "binance">, symbol: string, start: number, end: number, interval: "1s" | "1m"): Promise<Candle[]> {
  return src === "okx" ? okxRange(symbol, start, end, interval) : bybitRange(symbol, start, end, interval);
}

async function okxRange(symbol: string, start: number, end: number, interval: "1s" | "1m"): Promise<Candle[]> {
  const out: Candle[] = [];
  let after = end; // OKX devolve velas com horário < after, da mais nova para a mais antiga.
  for (let page = 0; page < 400; page++) {
    const rows = (await okxGet(`/api/v5/market/history-candles?instId=${okxId(symbol)}&bar=${interval}&after=${after}&limit=300`)) as string[][];
    if (rows.length === 0) break;
    for (const d of rows) {
      const t = Number(d[0]);
      if (t >= start && t < end) out.push({ time: t, open: +d[1]!, high: +d[2]!, low: +d[3]!, close: +d[4]! });
    }
    const oldest = Number(rows[rows.length - 1]![0]);
    if (oldest <= start || rows.length < 300) break;
    after = oldest;
  }
  return out.sort((a, b) => a.time - b.time);
}

async function bybitRange(symbol: string, start: number, end: number, interval: "1s" | "1m"): Promise<Candle[]> {
  if (interval === "1s") throw new Error("bybit não tem velas de 1 segundo");
  const out: Candle[] = [];
  let hi = end - 1;
  for (let page = 0; page < 50 && hi >= start; page++) {
    const res = (await bybitGet(`/v5/market/kline?category=spot&symbol=${symbol}&interval=1&start=${start}&end=${hi}&limit=1000`)) as { list: string[][] };
    const rows = res.list;
    if (rows.length === 0) break;
    for (const d of rows) out.push({ time: Number(d[0]), open: +d[1]!, high: +d[2]!, low: +d[3]!, close: +d[4]! });
    const oldest = Number(rows[rows.length - 1]![0]);
    if (rows.length < 1000) break;
    hi = oldest - 1;
  }
  return out.filter((c) => c.time >= start && c.time < end).sort((a, b) => a.time - b.time);
}

/** Todos os pares à vista em USDT (e USDTBRL) da corretora. */
export async function sourceTickers(src: Exclude<MarketSource, "binance">): Promise<SourcePair[]> {
  if (src === "okx") {
    const rows = (await okxGet("/api/v5/market/tickers?instType=SPOT")) as { instId: string; last: string; open24h: string; volCcy24h: string }[];
    return rows
      .filter((r) => r.instId.endsWith("-USDT") || r.instId === "USDT-BRL")
      .map((r) => {
        const price = Number(r.last);
        const open = Number(r.open24h);
        return { symbol: r.instId.replace("-", ""), price, changePct: open > 0 ? ((price - open) / open) * 100 : 0, quoteVolume: Number(r.volCcy24h) };
      });
  }
  const res = (await bybitGet("/v5/market/tickers?category=spot")) as { list: { symbol: string; lastPrice: string; price24hPcnt: string; turnover24h: string }[] };
  return res.list
    .filter((r) => r.symbol.endsWith("USDT") || r.symbol === "USDTBRL")
    .map((r) => ({ symbol: r.symbol, price: Number(r.lastPrice), changePct: Number(r.price24hPcnt) * 100, quoteVolume: Number(r.turnover24h) }));
}
