import { isFailure, PHASE_LABEL, type CycleStatus } from "@/lib/cycle-status";
import { cn } from "@/lib/utils";

const ago = (now: number, at: number | null) => {
  if (!at) return "nunca";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `há ${s}s` : `há ${Math.round(s / 60)} min`;
};

/** Diagnóstico da última rodada: separa "sem sinal" de falha e mostra a vida da nuvem. */
export function RunStatusLine({
  status,
  now,
  cloudBeat,
  serverRuns,
}: {
  status: CycleStatus | null;
  now: number;
  cloudBeat: number;
  serverRuns: boolean;
}) {
  const fail = status ? isFailure(status.phase) : false;
  const cloudAge = cloudBeat ? now - cloudBeat : Infinity;
  return (
    <div
      role="status"
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        fail ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground",
      )}
    >
      <p className="font-semibold">
        {status ? PHASE_LABEL[status.phase] : "Nenhuma rodada neste navegador ainda"}
        {status ? ` · ${ago(now, status.at)}` : ""}
      </p>
      {status?.detail && <p>{status.detail}</p>}
      <p>
        {status?.dataTotal != null && `Dados válidos: ${status.dataOk}/${status.dataTotal} moedas · `}
        Última rodada sem falha: {ago(now, status?.lastSuccessAt ?? null)}
        {serverRuns && ` · Nuvem: último sinal ${cloudBeat ? ago(now, cloudBeat) : "nunca"}${cloudAge > 150_000 ? " (atrasada)" : ""}`}
      </p>
    </div>
  );
}
