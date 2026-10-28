/**
 * Porta de rate limit (§3.6: por canal e por provedor). Hoje: balde de fichas em memória, por processo.
 * Para vários processos/workers, implementar esta mesma interface sobre Redis (script Lua ou INCR + EXPIRE).
 */
export interface RateLimiter {
  take(key: string, cost?: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

type Bucket = { tokens: number; updatedAt: number };

export class InMemoryTokenBucket implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly options: { capacity: number; refillPerSecond: number; now?: () => number; maxKeys?: number },
  ) {}

  async take(key: string, cost = 1) {
    const now = (this.options.now ?? Date.now)();
    const { capacity, refillPerSecond } = this.options;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * refillPerSecond);
    bucket.updatedAt = now;

    let result: { allowed: boolean; retryAfterMs: number };
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      result = { allowed: true, retryAfterMs: 0 };
    } else {
      result = { allowed: false, retryAfterMs: Math.ceil(((cost - bucket.tokens) / refillPerSecond) * 1000) };
    }
    this.buckets.delete(key); // reinserir mantém a ordem de uso (LRU simples)
    this.buckets.set(key, bucket);
    const maxKeys = this.options.maxKeys ?? 10_000;
    if (this.buckets.size > maxKeys) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }
    return result;
  }
}
