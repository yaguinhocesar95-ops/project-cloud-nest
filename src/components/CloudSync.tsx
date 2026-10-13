import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Bet } from "@/hooks/useBets";
import { mergeBets } from "@/lib/bet-engine";
import {
  ALL_SYNC_KEYS, AUDIT_KEY, BET_KEYS, CLOUD_OWNED_KEYS, DAILY_RESET_KEYS, RESET_DAY_KEY, SCALAR_KEYS, SUPREMO_BETS_KEY,
  TOMBSTONE_KEY, emitCloudPull, saoPauloDay,
} from "@/lib/cloud-keys";
import { isCloudStale } from "@/hooks/useSupremoAuto";
import { resolveScalar } from "@/lib/sync-resolve";
import { summarizeDay } from "@/lib/daily-stats";

const META_KEY = "ypx-sync-meta";
const META_AT_KEY = "ypx-sync-meta-at";
const LOCAL_AT_KEY = "ypx-local-changed-at";
const EVERY_MS = 15_000;
/** Leitura completa de segurança; nas demais, só as linhas alteradas. */
const FULL_EVERY_MS = 5 * 60_000;
/** Folga na consulta incremental para relógios levemente diferentes. */
const OVERLAP_MS = 60_000;

const readJson = <T,>(k: string, d: T): T => {
  try { return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? d; } catch { return d; }
};
const parse = (s: string | null): unknown => {
  try { return s == null ? null : JSON.parse(s); } catch { return null; }
};

// Registra quando o navegador mudou cada chave simples (para comparar com o updated_at da nuvem).
let watching = false;
let applyingRemote = false;
function watchLocalWrites() {
  if (watching || typeof Storage === "undefined") return;
  watching = true;
  const keys = new Set<string>(SCALAR_KEYS);
  const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k: string, v: string) {
    orig.call(this, k, v);
    if (!applyingRemote && this === window.localStorage && keys.has(k)) {
      const at = readJson<Record<string, number>>(LOCAL_AT_KEY, {});
      at[k] = Date.now();
      orig.call(this, LOCAL_AT_KEY, JSON.stringify(at));
    }
  };
}

type Row = { value: unknown; updatedAt: number };
const cache = new Map<string, Row>();
let cacheUser: string | null = null;
let lastFull = 0;
let cursor = 0;
let syncing = false;

async function pull(userId: string): Promise<boolean> {
  const now = Date.now();
  const full = cacheUser !== userId || now - lastFull > FULL_EVERY_MS;
  let q = supabase.from("user_kv").select("key, value, updated_at").eq("user_id", userId);
  if (!full) q = q.gt("updated_at", new Date(cursor - OVERLAP_MS).toISOString());
  const { data, error } = await q;
  if (error) return false;
  if (full) { cache.clear(); cacheUser = userId; lastFull = now; }
  for (const r of data ?? []) {
    const at = Date.parse(r.updated_at);
    cache.set(r.key, { value: r.value, updatedAt: at });
    if (at > cursor) cursor = at;
  }
  return true;
}

/** Antes de zerar o dia, guarda o resumo (só se a nuvem ainda não gravou). */
async function saveDailyStats(userId: string, day: string) {
  const bets = (parse(localStorage.getItem(SUPREMO_BETS_KEY)) as Bet[] | null) ?? [];
  if (!bets.length) return;
  const s = summarizeDay(day, bets);
  await supabase.from("daily_stats").upsert({ user_id: userId, ...s, by_coin: s.by_coin as never }, { onConflict: "user_id,day", ignoreDuplicates: true });
}

/** Mantém os dados do navegador e da nuvem iguais enquanto houver login. */
async function syncOnce(userId: string) {
  if (syncing) return;
  syncing = true;
  try {
    if (!(await pull(userId))) return;
    const server = new Map([...cache].map(([k, r]) => [k, r.value]));
    // Reset diário à meia-noite: zera apostas e auditoria (banca e ajustes ficam).
    const today = saoPauloDay();
    const prevDay = parse(localStorage.getItem(RESET_DAY_KEY));
    if (prevDay !== today) {
      if (typeof prevDay === "string") await saveDailyStats(userId, prevDay).catch(() => {});
      for (const k of DAILY_RESET_KEYS) { localStorage.setItem(k, "[]"); emitCloudPull(k); }
      localStorage.setItem(RESET_DAY_KEY, JSON.stringify(today));
    }
    if (server.get(RESET_DAY_KEY) !== today) {
      for (const k of DAILY_RESET_KEYS) server.set(k, []);
    }
    const meta = readJson<Record<string, string>>(META_KEY, {});
    const metaAt = readJson<Record<string, number>>(META_AT_KEY, {});
    const localAt = readJson<Record<string, number>>(LOCAL_AT_KEY, {});
    const cloudFresh = !isCloudStale(Date.now());
    const tomb = new Set<string>([
      ...((parse(localStorage.getItem(TOMBSTONE_KEY)) as string[] | null) ?? []),
      ...((server.get(TOMBSTONE_KEY) as string[] | undefined) ?? []),
    ]);
    const upserts: { user_id: string; key: string; value: never; updated_at: string }[] = [];
    const touched: string[] = [];
    for (const key of ALL_SYNC_KEYS) {
      const localRaw = localStorage.getItem(key);
      const local = parse(localRaw);
      const remote = server.has(key) ? server.get(key) : null;
      let merged: unknown;
      if ((BET_KEYS as readonly string[]).includes(key)) {
        merged = mergeBets((local as Bet[]) ?? [], (remote as Bet[]) ?? [], tomb);
      } else if (key === TOMBSTONE_KEY) {
        merged = [...tomb].slice(-5000);
      } else if (key === AUDIT_KEY) {
        const m = new Map<string, { id: string; at: number }>();
        for (const a of [...((local as never[]) ?? []), ...((remote as never[]) ?? [])] as { id: string; at: number }[]) m.set(a.id, a);
        merged = [...m.values()].sort((a, b) => b.at - a.at).slice(0, 60);
      } else {
        const side = resolveScalar({
          localRaw, lastSynced: meta[key], localChangedAt: localAt[key], remote,
          remoteUpdatedAt: cache.get(key)?.updatedAt, lastSyncAt: metaAt[key],
          cloudOwns: cloudFresh && CLOUD_OWNED_KEYS.includes(key),
        });
        merged = side === "local" ? local : remote;
      }
      if (merged == null) continue;
      const json = JSON.stringify(merged);
      if (json !== localRaw) {
        applyingRemote = true;
        try { localStorage.setItem(key, json); } finally { applyingRemote = false; }
        emitCloudPull(key);
      }
      // Dono = nuvem: o navegador não grava essa chave enquanto ela der sinal de vida.
      const readOnly = cloudFresh && CLOUD_OWNED_KEYS.includes(key);
      if (!readOnly && json !== JSON.stringify(remote)) {
        upserts.push({ user_id: userId, key, value: merged as never, updated_at: new Date().toISOString() });
      }
      meta[key] = json;
      touched.push(key);
    }
    if (upserts.length) {
      const { error } = await supabase.from("user_kv").upsert(upserts);
      if (!error) for (const u of upserts) cache.set(u.key, { value: u.value, updatedAt: Date.parse(u.updated_at) });
    }
    const at = Date.now();
    for (const k of touched) metaAt[k] = at;
    localStorage.setItem(META_KEY, JSON.stringify(meta));
    localStorage.setItem(META_AT_KEY, JSON.stringify(metaAt));
  } finally {
    syncing = false;
  }
}

export function CloudSync() {
  useEffect(() => {
    watchLocalWrites();
    let userId: string | null = null;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = (uid: string | null) => {
      userId = uid;
      if (id) clearInterval(id);
      id = null;
      if (!uid) return;
      void syncOnce(uid);
      id = setInterval(() => userId && void syncOnce(userId), EVERY_MS);
    };
    void supabase.auth.getSession().then(({ data }) => start(data.session?.user.id ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") start(session?.user.id ?? null);
    });
    return () => {
      sub.subscription.unsubscribe();
      if (id) clearInterval(id);
    };
  }, []);
  return null;
}
