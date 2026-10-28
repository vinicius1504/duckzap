import { describe, expect, it } from "vitest";
import { isLocked, LOCK_MINUTES, MAX_FAILED_ATTEMPTS, nextFailureState, RateLimiter } from "./rate-limit";

describe("RateLimiter (janela deslizante)", () => {
  it("bloqueia depois de max tentativas e libera quando a janela passa", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 3, windowMs: 1000, now: () => now });
    expect(limiter.hit("ip").allowed).toBe(true);
    expect(limiter.hit("ip").allowed).toBe(true);
    expect(limiter.hit("ip").allowed).toBe(true);
    const blocked = limiter.hit("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1000);
    now = 999;
    expect(limiter.hit("ip").allowed).toBe(false);
    now = 1000;
    expect(limiter.hit("ip").allowed).toBe(true);
  });

  it("tentativas bloqueadas não estendem o bloqueio", () => {
    let now = 0;
    const limiter = new RateLimiter({ max: 1, windowMs: 1000, now: () => now });
    limiter.hit("a");
    now = 500;
    limiter.hit("a");
    limiter.hit("a");
    now = 1000;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("chaves são independentes (por IP e por conta)", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    expect(limiter.hit("1.1.1.1").allowed).toBe(true);
    expect(limiter.hit("2.2.2.2").allowed).toBe(true);
    expect(limiter.hit("1.1.1.1").allowed).toBe(false);
    limiter.reset("1.1.1.1");
    expect(limiter.hit("1.1.1.1").allowed).toBe(true);
  });
});

describe("trava de conta", () => {
  it("conta falhas e trava no limite, zerando o contador", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      state = nextFailureState(state.failedAttempts, now);
      expect(state.lockedUntil).toBeNull();
      expect(state.failedAttempts).toBe(i);
    }
    state = nextFailureState(state.failedAttempts, now);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil?.getTime()).toBe(now.getTime() + LOCK_MINUTES * 60_000);
  });

  it("isLocked respeita o instante de desbloqueio", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    expect(isLocked(null, now)).toBe(false);
    expect(isLocked(new Date(now.getTime() + 1), now)).toBe(true);
    expect(isLocked(now, now)).toBe(false);
  });
});
