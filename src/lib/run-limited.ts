/**
 * Roda `fn` para cada item com no máximo `limit` ao mesmo tempo. Itens que não
 * começaram antes do prazo (`deadline`, ms) voltam em `deferred` — nunca somem.
 */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  deadline: number,
  fn: (item: T) => Promise<void>,
  now: () => number = Date.now,
): Promise<{ done: T[]; deferred: T[] }> {
  const done: T[] = [];
  const deferred: T[] = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++]!;
      if (now() >= deadline) {
        deferred.push(item);
        continue;
      }
      await fn(item);
      done.push(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return { done, deferred };
}
