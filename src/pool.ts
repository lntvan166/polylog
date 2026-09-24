export function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Run fn over items with at most `limit` in flight. Never rejects; each item settles on its own. */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, signal: AbortSignal) => Promise<R>,
  signal: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results: (PromiseSettledResult<R> | undefined)[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length && !signal.aborted) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], signal) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return Array.from(results, (r): PromiseSettledResult<R> => r ?? { status: "rejected", reason: abortError() });
}
