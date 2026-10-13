import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

/** Mais que isso sem rodada bem-sucedida: alerta. */
export const STALE_MS = 3 * 60_000;

/** Painel da rodada automática na nuvem: última rodada, duração, requisições e usuários. */
export function CloudStatus() {
  const q = useQuery({
    queryKey: ["cron-status"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("cron_status");
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 30_000,
    retry: false,
  });
  if (q.isError || !q.data) return null;
  const last = q.data[0];
  const lastOk = q.data.find((r) => r.ok && !r.skipped);
  const streak = (() => { let n = 0; for (const r of q.data) { if (r.ok) n++; else break; } return n; })();
  const stale = !lastOk || Date.now() - new Date(lastOk.ran_at).getTime() > STALE_MS;
  const ago = (iso: string) => `${Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))} s atrás`;
  return (
    <section
      className={cn(
        "rounded-lg border bg-card p-3 text-xs",
        stale ? "border-destructive text-destructive" : "border-border text-muted-foreground",
      )}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-foreground">Rodada na nuvem</span>
        {last ? (
          <>
            <span>última: {ago(last.ran_at)}{last.skipped ? " (pulada: outra em andamento)" : last.ok ? "" : " — falhou"}</span>
            <span className="font-mono">{(last.duration_ms / 1000).toFixed(1)} s</span>
            <span className="font-mono">{last.requests} requisições</span>
            <span>{last.users_processed} usuários{last.users_deferred ? `, ${last.users_deferred} adiados` : ""}</span>
            <span>{streak} seguidas OK</span>
          </>
        ) : (
          <span>nenhuma rodada registrada</span>
        )}
      </div>
      {stale && <p className="mt-1 font-medium">Atenção: mais de 3 minutos sem rodada bem-sucedida na nuvem.</p>}
    </section>
  );
}
