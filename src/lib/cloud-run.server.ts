/**
 * Rodada automática no servidor: para cada usuário com o automático ligado,
 * avança as apostas com o preço atual e gera a aposta Supremo do minuto.
 */
import type { Bet } from "@/hooks/useBets";
import type { Bankroll } from "@/hooks/useBankroll";
import { advanceBet, buildBet, mergeBets, supremoBetId } from "@/lib/bet-engine";
import { ALL_SYNC_KEYS, AUDIT_KEY, AUTO_ON_KEY, BANKROLL_KEY, BET_KEYS, CLOUD_BEAT_KEY, DAILY_RESET_KEYS, RESET_DAY_KEY, SUPREMO_BETS_KEY, TOMBSTONE_KEY, saoPauloDay } from "@/lib/cloud-keys";
import { REST_BASE, fetchWithTimeout, pickServerHost } from "@/lib/binance";
import { setMarketSource, sourceTickers, type MarketSource } from "@/lib/market-source";
import { buildMarketSnapshot, runSupremoCycle, type MarketSnapshot } from "@/lib/supremo-cycle";
import { runLimited } from "@/lib/run-limited";
import { summarizeDay } from "@/lib/daily-stats";
import { RESOLVE_MODE_KEY, applyCandleOfficial, closedCandles, parseResolveMode, stepCandleShadow } from "@/lib/candle-resolution";
import type { Candle } from "@/lib/replay";
import { exposureBlock, readExposure } from "@/lib/supremo-live";

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

/** localStorage em memória, preenchido com os dados do usuário durante a rodada. */
function installStorage(data: Map<string, string>) {
  const g = globalThis as { localStorage?: Storage };
  const prev = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return () => {
    if (prev) g.localStorage = prev;
    else delete g.localStorage;
  };
}

async function fetchAllPrices(src: MarketSource): Promise<Map<string, number>> {
  if (src !== "binance") return new Map((await sourceTickers(src)).map((r) => [r.symbol, r.price]));
  const res = await fetchWithTimeout(`${REST_BASE}/api/v3/ticker/price`);
  if (!res.ok) throw new Error(`ticker/price falhou (${res.status})`);
  const rows = (await res.json()) as { symbol: string; price: string }[];
  return new Map(rows.map((r) => [r.symbol, Number(r.price)]));
}

/** Mínimo de moedas com velas completas para o snapshot valer (de 10). */
export const MIN_SNAPSHOT_COINS = 8;
/**
 * Ordem das corretoras da nuvem. Cada tentativa monta o snapshot INTEIRO numa só
 * corretora; se falhar ou vier incompleto, refaz tudo na próxima (sem misturar).
 * A Bybit não tem velas de 1 s: com ela, as apostas abertas andam, mas nenhuma
 * moeda é liberada para aposta nova (dado incompleto não libera sinal).
 */
export const SOURCE_ORDER: MarketSource[] = ["okx", "binance", "bybit"];

export async function buildCloudMarket(): Promise<{ source: MarketSource; prices: Map<string, number>; snapshot: MarketSnapshot; attempts: string[]; degraded: boolean }> {
  const attempts: string[] = [];
  for (const src of SOURCE_ORDER) {
    try {
      setMarketSource(src);
      if (src === "binance") await pickServerHost();
      const [prices, snapshot] = await Promise.all([fetchAllPrices(src), buildMarketSnapshot({ incremental: true })]);
      const good = snapshot.results.filter((r) => r.ok && r.value.cur.length > 0).length;
      if (src === "bybit") {
        if (prices.size === 0) throw new Error("sem preços");
        // Só acompanha apostas: descarta qualquer linha para não liberar sinal sem velas de 1 s.
        const results = snapshot.pairs.map(() => ({ ok: false as const, error: "bybit não tem velas de 1 s" }));
        attempts.push(`bybit: preços ok (${prices.size}); análise Supremo pausada`);
        return { source: src, prices, snapshot: { ...snapshot, results }, attempts, degraded: true };
      }
      if (good < Math.min(MIN_SNAPSHOT_COINS, snapshot.pairs.length) || snapshot.btc.length === 0 || snapshot.eth.length === 0)
        throw new Error(`snapshot incompleto (${good}/${snapshot.pairs.length} moedas, btc ${snapshot.btc.length}, eth ${snapshot.eth.length})`);
      attempts.push(`${src}: ok (${good}/${snapshot.pairs.length})`);
      return { source: src, prices, snapshot, attempts, degraded: false };
    } catch (e) {
      attempts.push(`${src}: ${(e as Error).message}`.slice(0, 300));
    }
  }
  setMarketSource("okx");
  throw new Error(`nenhuma corretora respondeu: ${attempts.join(" | ")}`);
}

const parse = <T,>(s: string | undefined, d: T): T => {
  try { return s == null ? d : (JSON.parse(s) as T); } catch { return d; }
};

/** Usuários processados ao mesmo tempo e orçamento de tempo da rodada. */
export const USER_CONCURRENCY = 3;
export const USER_BUDGET_MS = 40_000;
const LEASE_S = 120;

/**
 * Trava no banco (lease de 120 s, UPDATE condicional atômico): vale entre todas as
 * instâncias do Worker. Sem a trava, devolve { skipped: true } sem erro.
 */
export async function runCloudCycle(admin: Admin) {
  const holder = crypto.randomUUID();
  const { data: got, error: lockErr } = await admin.rpc("try_cron_lock", { p_holder: holder, p_lease_seconds: LEASE_S });
  if (lockErr) throw lockErr;
  if (!got) return { skipped: true, processed: 0, deferred: [] as string[] };
  const started = Date.now();
  try {
    // O automático vem LIGADO por padrão (igual ao navegador): só fica de fora quem desligou.
    const { data: rows, error } = await admin.from("user_kv").select("user_id, key, value").in("key", [AUTO_ON_KEY, BANKROLL_KEY]);
    if (error) throw error;
    const off = new Set((rows ?? []).filter((r) => r.key === AUTO_ON_KEY && (r.value === false || r.value === "false")).map((r) => r.user_id));
    const users = [...new Set((rows ?? []).filter((r) => r.key === BANKROLL_KEY).map((r) => r.user_id))].filter((u) => !off.has(u));
    if (users.length === 0) return { users: 0, processed: 0, deferred: [] as string[] };
    // Dados de mercado UMA vez por rodada, de UMA corretora, compartilhados entre os usuários.
    const { source, prices, snapshot, attempts, degraded } = await buildCloudMarket();
    const host = source;
    const usdtBrl = prices.get("USDTBRL") ?? null;
    const report: Record<string, string> = {};
    // O shim de localStorage é global: com 3 usuários ao mesmo tempo, a parte que usa
    // o shim (síncrona entre awaits do ciclo) roda numa fila; leituras/gravações no banco correm em paralelo.
    const { done, deferred } = await runLimited(users, USER_CONCURRENCY, started + USER_BUDGET_MS, async (uid) => {
      try {
        report[uid] = await runForUser(admin, uid, prices, usdtBrl, snapshot);
      } catch (e) {
        report[uid] = `erro: ${(e as Error).message}`;
      }
    });
    for (const u of deferred) report[u] = "adiado (sem tempo nesta rodada)";
    return { users: users.length, processed: done.length, deferred, host, source, degraded, attempts, report };
  } finally {
    await admin.rpc("release_cron_lock", { p_holder: holder });
  }
}

// Fila para o trecho que usa o localStorage em memória (global do processo).
let storageQueue: Promise<unknown> = Promise.resolve();
function withStorage<T>(data: Map<string, string>, fn: () => Promise<T>): Promise<T> {
  const run = storageQueue.then(async () => {
    const restore = installStorage(data);
    try { return await fn(); } finally { restore(); }
  });
  storageQueue = run.catch(() => {});
  return run;
}

async function runForUser(admin: Admin, uid: string, prices: Map<string, number>, usdtBrl: number | null, snapshot: MarketSnapshot): Promise<string> {
  const { data: rows, error } = await admin.from("user_kv").select("key, value").eq("user_id", uid).in("key", ALL_SYNC_KEYS);
  if (error) throw error;
  const data = new Map<string, string>();
  for (const r of rows ?? []) data.set(r.key, JSON.stringify(r.value));
  const before = new Map(data);
  // Reset diário à meia-noite (Brasília): zera apostas e auditoria, sem mesclar com o antigo.
  const today = saoPauloDay();
  const didReset = data.get(RESET_DAY_KEY) !== JSON.stringify(today);
  if (didReset) {
    // Antes de zerar, guarda o resumo do dia que terminou.
    const prevDay = parse<string | null>(data.get(RESET_DAY_KEY), null);
    const dayBets = parse<Bet[]>(data.get(SUPREMO_BETS_KEY), []);
    if (prevDay && dayBets.length) {
      const st = summarizeDay(prevDay, dayBets);
      const { error: dsErr } = await admin.from("daily_stats").upsert({ user_id: uid, ...st, by_coin: st.by_coin as never }, { onConflict: "user_id,day" });
      if (dsErr) throw dsErr;
    }
    for (const k of DAILY_RESET_KEYS) data.set(k, "[]");
    data.set(RESET_DAY_KEY, JSON.stringify(today));
  }
  const dead = new Set(parse<string[]>(data.get(TOMBSTONE_KEY), []));
  const now = Date.now();

  // Velas de 1 s fechadas por moeda (do snapshot), para a resolução "por vela".
  const mode = parseResolveMode(parse<unknown>(data.get(RESOLVE_MODE_KEY), null));
  const closedBy = new Map<string, Candle[]>();
  snapshot.pairs.forEach((p, i) => {
    const r = snapshot.results[i];
    if (r?.ok) closedBy.set(p.symbol, closedCandles([...r.value.prev, ...r.value.cur], r.value.fetchedAt));
  });

  // 1) Avança todas as listas de apostas com o preço atual (e a sombra por vela).
  for (const key of BET_KEYS) {
    const list = parse<Bet[]>(data.get(key), []);
    if (list.length === 0) continue;
    let changed = false;
    const next = list.map((b) => {
      const r = advanceBet(b, prices.get(b.symbol) ?? null, now, key === SUPREMO_BETS_KEY);
      let nb = r.bet;
      const closed = closedBy.get(b.symbol);
      if (closed && (b.status === "pending" || b.status === "open" || (b.candleShadow && b.candleShadow.status !== "win" && b.candleShadow.status !== "loss"))) {
        const shadow = stepCandleShadow(b, b.candleShadow, closed);
        if (mode === "candle" && (b.status === "pending" || b.status === "open")) {
          // Opção "por vela": ignora gatilho/alvo/stop por preço; cancelamento por prazo continua.
          if (r.kind) nb = b;
          nb = applyCandleOfficial(nb, shadow);
        }
        if (JSON.stringify(shadow) !== JSON.stringify(b.candleShadow)) nb = { ...nb, candleShadow: shadow };
      }
      if (nb !== b) changed = true;
      return nb;
    });
    if (changed) data.set(key, JSON.stringify(next));
  }

  // 2) Gera a aposta Supremo do minuto.
  let result = "sem aposta";
  const bankroll = parse<Bankroll | null>(data.get(BANKROLL_KEY), null);
  if (bankroll && bankroll.stake > 0) {
    result = await withStorage(data, async () => {
      const bets = parse<Bet[]>(data.get(SUPREMO_BETS_KEY), []);
      const r = await runSupremoCycle({ bets, bankroll, usdtBrl, livePrices: prices, place: true, snapshot });
      if (r.bet) {
        const blocked = exposureBlock(bets, r.bet.symbol, r.bet.combo, readExposure(), Date.now());
        const built = blocked ? null : buildBet(r.bet, null, "USDT", null, Date.now());
        if (built) {
          const bet = { ...built, id: supremoBetId(uid, snapshot.t, built.symbol, r.bet.combo) };
          if (bets.some((b) => b.id === bet.id)) return `já registrada em ${bet.symbol}`;
          data.set(SUPREMO_BETS_KEY, JSON.stringify([bet, ...bets]));
          return `aposta em ${bet.symbol}`;
        }
        return `bloqueada: ${blocked}`;
      }
      return r.note ?? "sem aposta";
    });
  } else result = "sem valor por aposta";

  // Sinal de vida: o navegador só assume a geração quando este horário fica velho.
  data.set(CLOUD_BEAT_KEY, JSON.stringify(Date.now()));

  // 3) Grava só o que mudou, mesclando com o que o navegador enviou nesse meio-tempo.
  const changedKeys = [...data.keys()].filter((k) => data.get(k) !== before.get(k) && ALL_SYNC_KEYS.includes(k));
  if (changedKeys.length) {
    const { data: fresh } = await admin.from("user_kv").select("key, value").eq("user_id", uid).in("key", changedKeys);
    const freshMap = new Map((fresh ?? []).map((r) => [r.key, r.value]));
    const upserts = changedKeys.map((k) => {
      let value: unknown = JSON.parse(data.get(k)!);
      const latest = didReset ? undefined : freshMap.get(k);
      if ((BET_KEYS as readonly string[]).includes(k) && Array.isArray(latest)) value = mergeBets(value as Bet[], latest as Bet[], dead);
      else if (k === AUDIT_KEY && Array.isArray(latest)) {
        const m = new Map<string, { id: string; at: number }>();
        for (const a of [...(value as { id: string; at: number }[]), ...(latest as { id: string; at: number }[])]) m.set(a.id, a);
        value = [...m.values()].sort((a, b) => b.at - a.at).slice(0, 60);
      }
      return { user_id: uid, key: k, value: value as never, updated_at: new Date().toISOString() };
    });
    const { error: upErr } = await admin.from("user_kv").upsert(upserts);
    if (upErr) throw upErr;
  }
  return result;
}
