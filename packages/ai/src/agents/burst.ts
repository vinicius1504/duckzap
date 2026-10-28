/**
 * Agregação de rajada (§4.1): mensagens que chegam em sequência são juntadas e respondidas uma vez.
 * Debounce de `windowMs` (padrão 4 s) com teto de `maxWaitMs` (padrão 5 s desde a primeira) para
 * não adiar para sempre quem digita sem parar. O lock por conversa (Redis `conv:{id}`) é responsabilidade do worker.
 */
export type BurstTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
};

const realTimers: BurstTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createBurstAggregator<T>(options: {
  onFlush: (key: string, items: T[]) => void | Promise<void>;
  windowMs?: number;
  maxWaitMs?: number;
  timers?: BurstTimers;
}) {
  const windowMs = options.windowMs ?? 4000;
  const maxWaitMs = options.maxWaitMs ?? 5000;
  const timers = options.timers ?? realTimers;
  const buckets = new Map<string, { items: T[]; handle: unknown; firstAt: number }>();

  function flush(key: string) {
    const bucket = buckets.get(key);
    if (!bucket) return;
    timers.clearTimeout(bucket.handle);
    buckets.delete(key);
    void options.onFlush(key, bucket.items);
  }

  return {
    push(key: string, item: T) {
      const existing = buckets.get(key);
      const now = timers.now();
      const firstAt = existing?.firstAt ?? now;
      if (existing) timers.clearTimeout(existing.handle);
      const wait = Math.max(0, Math.min(windowMs, firstAt + maxWaitMs - now));
      const handle = timers.setTimeout(() => flush(key), wait);
      buckets.set(key, { items: [...(existing?.items ?? []), item], handle, firstAt });
    },
    flush,
    pending: (key: string) => buckets.get(key)?.items.length ?? 0,
  };
}
