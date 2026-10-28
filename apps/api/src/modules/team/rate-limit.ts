import type { MiddlewareHandler } from "hono";
import { clientIp, socketAddressOf } from "../../lib/client-ip";
import { loadSecurityConfig } from "../../middleware/security-config";

/**
 * Limite simples em memória (janela fixa) por chave para endpoints públicos sensíveis (aceite de convite).
 * A interface `(key, now) => boolean` é a que um Redis (INCR + EXPIRE) passa a implementar com várias instâncias.
 */
export function createRateLimiter({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string, now = Date.now()) => {
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

/**
 * Limite por IP. O IP vem de `lib/client-ip.ts`: socket, ou o ÚLTIMO item de x-forwarded-for quando `TRUST_PROXY=true`
 * (o primeiro item é do cliente e dava para trocar a cada tentativa). Sem IP conhecido, todos caem no mesmo balde.
 */
export function rateLimitByIp(options: { windowMs: number; max: number; scope: string; trustProxy?: boolean }): MiddlewareHandler {
  const allow = createRateLimiter(options);
  return async (c, next) => {
    const trustProxy = options.trustProxy ?? loadSecurityConfig().trustProxy;
    const ip = clientIp(c.req.raw, { trustProxy, socketAddress: socketAddressOf(c.env) }) ?? "unknown";
    if (!allow(`${options.scope}:${ip}`)) {
      return c.json({ error: { code: "rate_limited", message: "Muitas tentativas. Aguarde um minuto e tente de novo." } }, 429);
    }
    await next();
  };
}
