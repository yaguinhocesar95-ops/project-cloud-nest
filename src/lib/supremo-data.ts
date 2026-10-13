/**
 * Supremo — busca de velas de 1 s reais da Binance, com cache por par e hora
 * fechada (memória + IndexedDB), concorrência limitada e retry com backoff.
 */
import { REST_BASE } from "./binance";
import { HttpError, fetchJsonTimed, isArray } from "./fetch-json";
import { getMarketSource, sourceRange } from "./market-source";

/** Chaves de cache separadas por corretora: velas de fontes diferentes nunca se misturam. */
const ck = (k: string) => { const s = getMarketSource(); return s === "binance" ? k : `${s}:${k}`; };
import { KLINE_PAGE, type Candle } from "./replay";
import { HOUR_MS } from "./supremo";

export const MAX_CONCURRENCY = 6;
const DB_NAME = "ypx-supremo";
const STORE = "hours";

export type UniverseCoin = { symbol: string; quote: string; quoteVolume: number; volumeUsdt: number; price: number };

type Ticker24h = { symbol: string; lastPrice: string; quoteVolume: string };

export async function fetchUniverse(opts: {
  quote: "USDT" | "BRL";
  minVolumeUsdt: number;
  topN: number | null;
  usdtBrl: number | null;
}): Promise<UniverseCoin[]> {
  const [rows, info] = await Promise.all([
    fetchJsonTimed<Ticker24h[]>(`${REST_BASE}/api/v3/ticker/24hr`, { validate: isArray as never }),
    fetchJsonTimed<{ symbols: { symbol: string; quoteAsset: string }[] }>(
      `${REST_BASE}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING`,
    ).catch(() => null),
  ]);
  const active = new Set<string>();
  for (const s of info?.symbols ?? []) if (s.quoteAsset === opts.quote) active.add(s.symbol);
  const fx = opts.quote === "BRL" ? opts.usdtBrl : 1;
  if (!fx) throw new Error("cotação USDT/BRL indisponível");
  const list = rows
    .filter((r) => r.symbol.endsWith(opts.quote) && (active.size === 0 || active.has(r.symbol)))
    .map((r) => {
      const qv = Number(r.quoteVolume);
      return { symbol: r.symbol, quote: opts.quote, quoteVolume: qv, volumeUsdt: qv / fx, price: Number(r.lastPrice) };
    })
    .filter((r) => r.price > 0 && r.volumeUsdt >= opts.minVolumeUsdt)
    .sort((a, b) => b.volumeUsdt - a.volumeUsdt);
  return opts.topN ? list.slice(0, opts.topN) : list;
}

// ===== Limitador (6 simultâneas) + peso =====
let active = 0;
const queue: (() => void)[] = [];
async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((r) => queue.push(r));
  active++;
}
function release() {
  active--;
  queue.shift()?.();
}
let pauseUntil = 0;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("cancelado", "AbortError"));
    });
  });

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    const wait = pauseUntil - Date.now();
    if (wait > 0) await sleep(wait, signal);
    await acquire();
    let status = 0;
    try {
      // Tempo-limite cobre headers E corpo: o timer só é limpo depois do JSON lido.
      return await fetchJsonTimed(url, {
        ms: 15_000,
        signal,
        fetchImpl: async (u, init) => {
          const res = await fetch(u, init);
          const used = Number(res.headers.get("x-mbx-used-weight-1m"));
          // Perto do limite de 6000/min: pausa preventiva.
          if (used > 4800) pauseUntil = Date.now() + 15_000;
          if (res.status === 429 || res.status === 418) {
            const retry = Number(res.headers.get("retry-after")) || 30;
            pauseUntil = Date.now() + retry * 1000;
          }
          return res;
        },
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      status = e instanceof HttpError ? e.status : 0;
      // 4xx (símbolo removido, parâmetro inválido): não repete.
      if (status >= 400 && status < 500 && status !== 429 && status !== 418) throw new Error(`Binance ${status}`);
      if (attempt >= 4) throw status === 429 || status === 418 ? new Error(`Binance limite (${status})`) : status ? new Error(`Binance ${status}`) : e;
      if (status !== 429 && status !== 418) await sleep(500 * 2 ** attempt, signal);
      attempt++;
    } finally {
      release();
    }
  }
}

async function fetchRange(
  symbol: string,
  start: number,
  end: number,
  signal?: AbortSignal,
  interval: "1s" | "1m" = "1s",
): Promise<Candle[]> {
  const src = getMarketSource();
  if (src !== "binance") return sourceRange(src, symbol, start, end, interval);
  const out: Candle[] = [];
  const step = interval === "1m" ? 60_000 : 1000;
  let cursor = start;
  while (cursor < end) {
    const url = `${REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${end - 1}&limit=${KLINE_PAGE}`;
    const rows = (await fetchJson(url, signal)) as unknown[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({ time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) });
    }
    const last = Number(rows[rows.length - 1]![0]);
    if (rows.length < KLINE_PAGE) break;
    cursor = last + step;
  }
  return out;
}

// ===== Cache =====
const mem = new Map<string, Candle[]>();
/** Limite do cache em memória (horas fechadas), para o Worker não crescer sem fim. */
export const MEM_CACHE_MAX = 48;
function memSet(key: string, v: Candle[]) {
  mem.delete(key);
  mem.set(key, v);
  while (mem.size > MEM_CACHE_MAX) mem.delete(mem.keys().next().value!);
}
/**
 * Retenção do cache local (só do banco próprio do app, `ypx-supremo`):
 * - `m1:` (janela 24 h, uma chave por hora corrente) — guarda só as 2 últimas horas;
 * - horas fechadas de 1 s — 48 h;
 * - `m1d:` (dias fechados) — 8 dias.
 * Chave desconhecida ou sem carimbo de tempo nunca é apagada.
 */
export const RETENTION_MS = { m1: 2 * HOUR_MS, hour: 48 * HOUR_MS, m1d: 8 * 24 * HOUR_MS } as const;
export function isExpiredKey(key: string, now: number): boolean {
  const parts = key.split(":");
  const ts = Number(parts[parts.length - 1]);
  if (!Number.isFinite(ts) || ts <= 0 || parts.length < 2) return false;
  const kind = parts.includes("m1d") ? "m1d" : parts.includes("m1") ? "m1" : "hour";
  return now - ts > RETENTION_MS[kind];
}
let lastPrune = 0;
/** Expurga chaves vencidas do cache do app. No máximo uma vez a cada 10 min. */
export async function pruneCache(now = Date.now()): Promise<number> {
  if (now - lastPrune < 10 * 60_000) return 0;
  lastPrune = now;
  for (const k of [...mem.keys()]) if (isExpiredKey(k, now)) mem.delete(k);
  const d = await db();
  if (!d) return 0;
  return new Promise((resolve) => {
    let removed = 0;
    const tx = d.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).openKeyCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (isExpiredKey(String(cur.key), now)) {
        tx.objectStore(STORE).delete(cur.key);
        removed++;
      }
      cur.continue();
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => resolve(removed);
  });
}
let dbp: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbp ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbp;
}
async function idbGet(key: string): Promise<Candle[] | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as Candle[] | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}
async function idbPut(key: string, value: Candle[]) {
  const d = await db();
  if (!d) return;
  void pruneCache();
  d.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
}

/** Uma hora fechada: baixada uma única vez, depois sempre do cache. */
export async function getClosedHour(symbol: string, hourStart: number, signal?: AbortSignal): Promise<Candle[]> {
  const key = ck(`${symbol}:${hourStart}`);
  const m = mem.get(key);
  if (m) return m;
  const stored = await idbGet(key);
  if (stored) {
    memSet(key, stored);
    return stored;
  }
  const data = await fetchRange(symbol, hourStart, hourStart + HOUR_MS, signal);
  memSet(key, data);
  void idbPut(key, data);
  return data;
}

/** Hora corrente (parcial): sempre refeita. */
export function getCurrentHour(symbol: string, hourStart: number, now: number, signal?: AbortSignal) {
  return fetchRange(symbol, hourStart, now, signal);
}

/**
 * Junta o que já estava em cache com as velas novas: a última vela antiga (que podia
 * estar em andamento) é substituída pela versão nova, se vier.
 */
export function mergeIncremental(cached: readonly Candle[], fresh: readonly Candle[]): Candle[] {
  if (fresh.length === 0) return [...cached];
  const firstNew = fresh[0]!.time;
  return [...cached.filter((c) => c.time < firstNew), ...fresh];
}

const curCache = new Map<string, { hourStart: number; candles: Candle[] }>();

/**
 * Hora corrente incremental (usada pela nuvem): baixa só as velas desde a última
 * leitura. Ao virar a hora, a hora que acabou vira cache de hora fechada.
 */
export async function getCurrentHourIncremental(symbol: string, hourStart: number, now: number, signal?: AbortSignal): Promise<Candle[]> {
  const c = curCache.get(ck(symbol));
  if (c && c.hourStart === hourStart - HOUR_MS) {
    // Fecha a hora anterior completando o finalzinho que faltava.
    const lastT = c.candles.length ? c.candles[c.candles.length - 1]!.time : c.hourStart;
    const tail = await fetchRange(symbol, lastT, hourStart, signal);
    memSet(ck(`${symbol}:${c.hourStart}`), mergeIncremental(c.candles, tail));
  }
  const cached = c && c.hourStart === hourStart ? c.candles : [];
  const from = cached.length ? cached[cached.length - 1]!.time : hourStart;
  const fresh = await fetchRange(symbol, from, now, signal);
  const merged = mergeIncremental(cached, fresh);
  curCache.set(ck(symbol), { hourStart, candles: merged });
  return merged;
}

/** Roda tarefas com retorno por item; erro vira `error` sem derrubar o resto. */
export async function mapSettled<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  onDone: (done: number) => void,
  signal?: AbortSignal,
): Promise<({ ok: true; value: R } | { ok: false; error: string })[]> {
  let done = 0;
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      try {
        out[i] = { ok: true, value: await fn(items[i]!) };
      } catch (e) {
        out[i] = { ok: false, error: (e as Error).message };
      }
      onDone(++done);
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, worker));
  if (signal?.aborted) throw new DOMException("cancelado", "AbortError");
  return out;
}

/**
 * Velas de 1 minuto das últimas 24 h: as 24 horas fechadas ficam em cache
 * (memória + IndexedDB, chave por hora corrente); a hora atual é refeita.
 */
export async function getMinuteCandles24h(symbol: string, now: number, signal?: AbortSignal): Promise<Candle[]> {
  const cur = Math.floor(now / HOUR_MS) * HOUR_MS;
  const key = ck(`m1:${symbol}:${cur}`);
  let closed = mem.get(key) ?? null;
  if (!closed) {
    closed = await idbGet(key);
    if (!closed) {
      closed = await fetchRange(symbol, cur - 24 * HOUR_MS, cur, signal, "1m");
      void idbPut(key, closed);
    }
    memSet(key, closed);
  }
  const partial = await fetchRange(symbol, cur, now, signal, "1m");
  return [...closed, ...partial];
}

/** Velas de 1 min de um intervalo qualquer (sem cache; para a sombra). */
export function getMinuteRange(symbol: string, from: number, to: number, signal?: AbortSignal): Promise<Candle[]> {
  return fetchRange(symbol, from, to, signal, "1m");
}

const DAY_MS = 24 * HOUR_MS;
/**
 * Velas de 1 min dos últimos `days` dias (máx. 7): cada dia fechado fica em
 * cache (memória + IndexedDB); o dia corrente é refeito.
 */
export async function getMinuteCandlesDays(symbol: string, now: number, days: number, signal?: AbortSignal): Promise<Candle[]> {
  const n = Math.max(1, Math.min(7, Math.floor(days)));
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const out: Candle[] = [];
  for (let d = n; d >= 1; d--) {
    const start = today - d * DAY_MS;
    const key = `m1d:${symbol}:${start}`;
    let v = mem.get(key) ?? null;
    if (!v) {
      v = await idbGet(key);
      if (!v) {
        v = await fetchRange(symbol, start, start + DAY_MS, signal, "1m");
        void idbPut(key, v);
      }
      memSet(key, v);
    }
    out.push(...v);
  }
  out.push(...(await fetchRange(symbol, today, now, signal, "1m")));
  return out;
}
