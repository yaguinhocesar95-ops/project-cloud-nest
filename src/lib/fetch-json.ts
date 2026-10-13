/**
 * fetch + leitura do JSON sob o MESMO tempo-limite e sinal: o timer só é limpo depois
 * que o corpo foi lido e validado (headers chegando não bastam). Sem dependências de DOM.
 */
export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} em ${url.replace(/\?.*$/, "")}`);
  }
}

export async function fetchJsonTimed<T = unknown>(
  url: string,
  opts: { ms?: number; signal?: AbortSignal | undefined; validate?: (v: unknown) => v is T; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const { ms = 15_000, signal, validate, fetchImpl = fetch } = opts;
  if (signal?.aborted) throw signal.reason ?? new DOMException("cancelado", "AbortError");
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(new DOMException("tempo esgotado", "TimeoutError")), ms);
  const onAbort = () => ctl.abort(signal?.reason ?? new DOMException("cancelado", "AbortError"));
  signal?.addEventListener("abort", onAbort, { once: true });
  // Corrida contra o abort: um corpo que nunca termina não pendura a chamada.
  const aborted = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
  });
  aborted.catch(() => {});
  try {
    const res = await Promise.race([fetchImpl(url, { signal: ctl.signal }), aborted]);
    if (!res.ok) throw new HttpError(res.status, url);
    const body = await Promise.race([res.json() as Promise<unknown>, aborted]);
    if (validate && !validate(body)) throw new Error(`resposta inválida de ${url.replace(/\?.*$/, "")}`);
    return body as T;
  } finally {
    clearTimeout(to);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Tenta cada host em ordem; 4xx (exceto 429/418) não é repetido no mesmo host, só passa ao próximo. */
export async function fetchJsonHosts<T = unknown>(
  hosts: readonly string[],
  path: string,
  opts: Parameters<typeof fetchJsonTimed<T>>[1] = {},
): Promise<T> {
  const errors: string[] = [];
  for (const h of hosts) {
    try {
      return await fetchJsonTimed<T>(`${h}${path}`, opts);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      errors.push((e as Error).message);
    }
  }
  throw new Error(`todas as fontes falharam: ${errors.join("; ")}`);
}

export const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
