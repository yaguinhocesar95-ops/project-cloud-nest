/**
 * Conta as requisições externas (Binance, OKX, Bybit…) feitas durante a rodada,
 * ignorando as chamadas ao próprio banco. Só para o registro em cron_runs.
 */
export function isExternal(url: string, ownHost: string | null): boolean {
  try {
    const h = new URL(url).host;
    return !ownHost || h !== ownHost;
  } catch {
    return false;
  }
}

export function countExternalFetches() {
  const g = globalThis as { fetch: typeof fetch };
  const orig = g.fetch;
  let own: string | null = null;
  try { own = process.env['SUPABASE_URL'] ? new URL(process.env['SUPABASE_URL']).host : null; } catch { own = null; }
  const state = { count: 0, stop: () => { g.fetch = orig; } };
  g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isExternal(url, own)) state.count++;
    return orig(input, init);
  }) as typeof fetch;
  return state;
}
