import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Bet } from "@/hooks/useBets";
import { CLOUD_PULL_EVENT, SUPREMO_BETS_KEY } from "@/lib/cloud-keys";
import { aggregateDays } from "@/lib/daily-stats";
import { breakEvenAtivo } from "@/lib/supremo-combo";
import { RESOLVE_MODE_KEY, compareResolutions, parseResolveMode, type ResolveMode } from "@/lib/candle-resolution";
import { cn } from "@/lib/utils";

const pct = (v: number | null, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d).replace(".", ",")}%`);
const card = "rounded-lg border border-border bg-card p-3 text-xs";

/** Últimos 30 dias (resumos gravados antes de cada reset diário). */
export function DailyHistory() {
  const q = useQuery({
    queryKey: ["daily-stats"],
    queryFn: async () => {
      const { data, error } = await supabase.from("daily_stats").select("day, bets, wins, losses, net_pct").order("day", { ascending: false }).limit(30);
      if (error) throw error;
      return data ?? [];
    },
    retry: false,
  });
  if (q.isError || !q.data) return null;
  const tot = aggregateDays(q.data);
  // Linha de referência = break-even do combo ativo (regra do projeto: nunca um valor fixo).
  const HIT_LINE = breakEvenAtivo();
  return (
    <section className={card}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-semibold text-foreground">Últimos 30 dias</span>
        <span className="text-muted-foreground">{tot.n} apostas encerradas</span>
        <span className={cn("font-mono", tot.hitRate != null && tot.hitRate >= HIT_LINE ? "text-primary" : "text-muted-foreground")}>
          acerto {pct(tot.hitRate)} (linha do break-even {pct(HIT_LINE, 0)})
        </span>
        <span className="font-mono text-muted-foreground">expectativa líquida {pct(tot.expectancy, 3)} por aposta</span>
      </div>
      {q.data.length === 0 ? (
        <p className="text-muted-foreground">O primeiro resumo aparece depois da próxima meia-noite (Brasília).</p>
      ) : (
        <div className="flex flex-wrap gap-1" aria-label="Acerto por dia">
          {[...q.data].reverse().map((d) => {
            const n = d.wins + d.losses;
            const hr = n ? d.wins / n : null;
            return (
              <span
                key={d.day}
                title={`${d.day}: ${d.wins}/${n} (${pct(hr)})`}
                className={cn("rounded px-1.5 py-0.5 font-mono", hr == null ? "bg-muted text-muted-foreground" : hr >= HIT_LINE ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive")}
              >
                {d.day.slice(8)} {pct(hr, 0)}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Comparação "por preço" × "por vela" das apostas Supremo de hoje, e a opção de qual vale. */
export function ResolutionCompare() {
  const [bets, setBets] = useState<Bet[]>([]);
  const [mode, setMode] = useState<ResolveMode>("price");
  useEffect(() => {
    const read = () => {
      try { setBets(JSON.parse(localStorage.getItem(SUPREMO_BETS_KEY) ?? "[]")); } catch { setBets([]); }
      try { setMode(parseResolveMode(JSON.parse(localStorage.getItem(RESOLVE_MODE_KEY) ?? "null"))); } catch { setMode("price"); }
    };
    read();
    window.addEventListener(CLOUD_PULL_EVENT, read);
    const id = setInterval(read, 15_000);
    return () => { window.removeEventListener(CLOUD_PULL_EVENT, read); clearInterval(id); };
  }, []);
  const c = compareResolutions(bets);
  const change = (m: ResolveMode) => { localStorage.setItem(RESOLVE_MODE_KEY, JSON.stringify(m)); setMode(m); };
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-foreground">Resolução: por preço × por vela fechada</span>
        <span className="text-muted-foreground">{c.both} apostas comparáveis hoje · {c.both ? `${c.agree} iguais` : "aguardando apostas encerradas"}</span>
        <span className="font-mono">preço {c.price.wins}/{c.price.wins + c.price.losses} ({pct(c.price.hitRate)})</span>
        <span className="font-mono">vela {c.candle.wins}/{c.candle.wins + c.candle.losses} ({pct(c.candle.hitRate)})</span>
        <label className="ml-auto flex items-center gap-2 text-muted-foreground">
          vale para o automático na nuvem
          <select className="rounded border border-border bg-background px-2 py-1" value={mode} onChange={(e) => change(e.target.value as ResolveMode)}>
            <option value="price">por preço (atual)</option>
            <option value="candle">por vela fechada</option>
          </select>
        </label>
      </div>
    </section>
  );
}
