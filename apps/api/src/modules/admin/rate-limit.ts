/** Janela deslizante em memória (por processo). Tentativas bloqueadas NÃO estendem o bloqueio. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly options: { max: number; windowMs: number; now?: () => number }) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Registra uma tentativa; `allowed=false` quando passou do limite dentro da janela. */
  hit(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((at) => now - at < this.options.windowMs);
    if (fresh.length >= this.options.max) {
      this.hits.set(key, fresh);
      return { allowed: false, retryAfterMs: Math.max(0, (fresh[0] ?? now) + this.options.windowMs - now) };
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    if (this.hits.size > 10_000) this.prune(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    for (const [key, list] of this.hits) {
      if (list.every((at) => now - at >= this.options.windowMs)) this.hits.delete(key);
    }
  }
}

/** Trava de conta (persistida no banco): decisão pura a partir dos contadores. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
/** Códigos 2FA errados por desafio antes de exigir recomeçar do e-mail/senha. */
export const MAX_CODE_ATTEMPTS = 5;

export function isLocked(lockedUntil: Date | null, now: Date) {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

/** Próximo estado após uma falha de senha/2FA: trava ao atingir o máximo e zera o contador. */
export function nextFailureState(failedAttempts: number, now: Date) {
  const total = failedAttempts + 1;
  if (total >= MAX_FAILED_ATTEMPTS) {
    return { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) };
  }
  return { failedAttempts: total, lockedUntil: null };
}
