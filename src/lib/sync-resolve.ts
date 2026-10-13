/** Decisão de conflito das chaves simples (não-listas) entre navegador e nuvem. */
export type ScalarInput = {
  localRaw: string | null;
  /** JSON gravado na última sincronização. */
  lastSynced: string | undefined;
  /** Quando o navegador mudou a chave pela última vez (ms), se sabido. */
  localChangedAt: number | undefined;
  remote: unknown;
  /** updated_at da linha na nuvem (ms). */
  remoteUpdatedAt: number | undefined;
  /** Hora da última sincronização desta chave (ms). */
  lastSyncAt: number | undefined;
  /** A nuvem é a dona desta chave agora (heartbeat fresco). */
  cloudOwns: boolean;
};

export function resolveScalar(i: ScalarInput): "local" | "remote" {
  if (i.remote == null) return "local";
  if (i.localRaw == null) return "remote";
  if (i.cloudOwns) return "remote";
  const localChanged = i.localRaw !== i.lastSynced;
  const remoteChanged = i.lastSyncAt == null || (i.remoteUpdatedAt ?? 0) > i.lastSyncAt;
  if (localChanged && !remoteChanged) return "local";
  if (!localChanged) return "remote";
  // Os dois mudaram: vence quem gravou por último.
  return (i.localChangedAt ?? 0) >= (i.remoteUpdatedAt ?? 0) ? "local" : "remote";
}
