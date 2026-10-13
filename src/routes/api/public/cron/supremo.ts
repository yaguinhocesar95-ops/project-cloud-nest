import { createFileRoute } from "@tanstack/react-router";

const RETENTION_MS = 7 * 24 * 3600_000;

export const Route = createFileRoute("/api/public/cron/supremo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { verifyCronToken } = await import("@/lib/cron-auth.server");
        if (!(await verifyCronToken(request, supabaseAdmin))) return new Response("Unauthorized", { status: 401 });
        const { runPriceProbe } = await import("@/lib/price-probe.server");
        const { runCloudCycle } = await import("@/lib/cloud-run.server");
        const { countExternalFetches } = await import("@/lib/fetch-counter");
        const started = Date.now();
        const counter = countExternalFetches();
        let cycle: Awaited<ReturnType<typeof runCloudCycle>> | null = null;
        let error: string | null = null;
        let probe: Awaited<ReturnType<typeof runPriceProbe>> = { responded: 0, total: 0, sources: [] } as never;
        try {
          try {
            probe = await runPriceProbe();
            cycle = await runCloudCycle(supabaseAdmin);
          } catch (e) {
            // Falha no probe ou no ciclo: ainda registramos erro e duração abaixo.
            error = (e as Error).message;
            console.error("cron supremo", e);
          }
        } finally {
          counter.stop();
        }
        const skipped = !!(cycle && "skipped" in cycle && cycle.skipped);
        const ok = probe.responded > 0 && !error;
        await supabaseAdmin.from("cron_runs").insert({
          ok, responded: probe.responded, total: probe.total, sources: (probe.sources ?? []) as string[],
          probe: probe as never, cycle: cycle as never, error, skipped,
          requests: counter.count, duration_ms: Date.now() - started,
          users_processed: cycle?.processed ?? 0, users_deferred: cycle?.deferred?.length ?? 0,
        });
        // Retenção: mantém só os últimos 7 dias do registro.
        await supabaseAdmin.from("cron_runs").delete().lt("ran_at", new Date(Date.now() - RETENTION_MS).toISOString());
        return Response.json({ ok, skipped, probe, cycle, error, requests: counter.count }, { status: ok ? 200 : 502 });
      },
    },
  },
});
