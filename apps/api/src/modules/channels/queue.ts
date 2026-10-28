/**
 * Porta de fila (§3.2). Hoje há só a implementação em memória (sem persistência, perde jobs no restart).
 *
 * Para ligar o BullMQ (futuro apps/worker):
 *  1. `BullQueue implements Queue` com `new Queue(name, { connection })` do Redis/Valkey (`VALKEY_URL` + senha);
 *     `enqueue` → `queue.add(name, payload, { jobId: opts.jobId, delay: opts.delayMs, attempts, backoff })`.
 *  2. `process` vira um `new Worker(name, handler, { concurrency, limiter })` no apps/worker (não na API).
 *  3. Jobs: `outbound.send` ({organizationId, channelId, message}) chamando `sendViaChannel` dentro de `withOrg`,
 *     e `inbound.process` chamando `processPendingInbound` (substitui o setImmediate do webhook e o cron de `reprocessPending`).
 *  4. Rate limit por canal passa a ser `RedisRateLimiter implements RateLimiter` (rate-limit.ts).
 */
/** `setTimeout` com atraso > 2^31-1 ms dispara em ~1 ms (overflow de 32 bits): acima do teto, reagenda em etapas. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export function setLongTimeout(run: () => void, delayMs: number, timers: { set: typeof setTimeout } = { set: setTimeout }): { cancel(): void } {
  let handle: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = (remaining: number) => {
    const step = Math.min(Math.max(0, remaining), MAX_TIMER_MS);
    handle = timers.set(() => {
      if (cancelled) return;
      if (remaining > step) arm(remaining - step);
      else run();
    }, step);
    handle.unref?.();
  };
  arm(delayMs);
  return {
    cancel() {
      cancelled = true;
      if (handle) clearTimeout(handle);
    },
  };
}

export type EnqueueOptions = { delayMs?: number; jobId?: string };

export interface Queue<T> {
  enqueue(name: string, payload: T, options?: EnqueueOptions): Promise<void>;
  process(name: string, handler: (payload: T) => Promise<void>): void;
}

export class InMemoryQueue<T> implements Queue<T> {
  private readonly handlers = new Map<string, (payload: T) => Promise<void>>();
  private readonly seen = new Set<string>();

  constructor(private readonly onError: (name: string, error: unknown) => void = () => {}) {}

  async enqueue(name: string, payload: T, options: EnqueueOptions = {}) {
    if (options.jobId) {
      const key = `${name}:${options.jobId}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const run = () => {
      const handler = this.handlers.get(name);
      if (!handler) return;
      void handler(payload).catch((error: unknown) => this.onError(name, error));
    };
    if (options.delayMs) setLongTimeout(run, options.delayMs);
    else queueMicrotask(run);
  }

  process(name: string, handler: (payload: T) => Promise<void>) {
    this.handlers.set(name, handler);
  }
}
