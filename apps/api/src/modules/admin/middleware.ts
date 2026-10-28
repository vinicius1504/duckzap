import type { Database } from "@duckzap/db";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ADMIN_COOKIE, getAdminSession, type AdminPrincipal } from "./auth-service";
import type { AdminConfig } from "./config";
import { clientIp, isIpAllowed, type IpRule } from "./ip";
import { RateLimiter } from "./rate-limit";

export type AdminBindings = {
  Variables: { requestId: string; admin: AdminPrincipal; adminIp: string | null; adminDb: Database };
};

export const errorBody = (code: string, message: string) => ({ error: { code, message } });

export function reply(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json(errorBody(code, message), status);
}

/** Endereço do socket (só vale como "IP do cliente" quando a API não está atrás de proxy; ver ADMIN_TRUST_PROXY). */
function socketAddress(c: Context): string | null {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Proteções comuns de TODA rota /v1/admin/*, antes de qualquer autenticação:
 * IP do cliente → allowlist → rate limit por IP → banco do painel disponível → Origin nas escritas → sem cache.
 */
export function adminGuard(options: {
  config: AdminConfig;
  rules: IpRule[];
  getDb: () => Database | null;
  globalLimiter: RateLimiter;
}): MiddlewareHandler<AdminBindings> {
  return async (c, next) => {
    const ip = clientIp({
      forwardedFor: c.req.header("x-forwarded-for"),
      socketAddress: socketAddress(c),
      trustProxy: options.config.ADMIN_TRUST_PROXY,
    });
    c.set("adminIp", ip);
    c.header("Cache-Control", "no-store");

    if (!isIpAllowed(ip, options.rules)) return reply(c, 403, "forbidden", "Acesso não permitido.");

    if (!options.globalLimiter.hit(ip ?? "unknown").allowed) {
      return reply(c, 429, "rate_limited", "Muitas requisições. Aguarde um instante.");
    }

    const db = options.getDb();
    if (!db) return reply(c, 503, "unavailable", "O painel está indisponível no momento.");
    c.set("adminDb", db);

    if (!SAFE_METHODS.has(c.req.method)) {
      // defesa extra contra CSRF além do SameSite=Strict: toda escrita precisa vir da origem do painel
      const origin = c.req.header("origin");
      if (!origin || !options.config.ADMIN_ORIGINS.includes(origin)) {
        return reply(c, 403, "forbidden", "Origem não permitida.");
      }
    }
    await next();
  };
}

/**
 * Exige sessão de ADMIN (cookie `dz_admin`, tabela `admin_sessions`). A sessão de cliente (cookie do Better Auth)
 * nunca é consultada aqui, e `requireAuth` das rotas dos clientes nunca lê `dz_admin`: as duas identidades não se misturam.
 * `lookup` é injetável para teste.
 */
export function requireAdmin(
  lookup: (db: Database, token: string) => Promise<AdminPrincipal | null> = getAdminSession,
): MiddlewareHandler<AdminBindings> {
  return async (c, next) => {
    const token = getCookie(c, ADMIN_COOKIE);
    if (!token || token.length > 200) return reply(c, 401, "unauthorized", "Entre para continuar.");
    const admin = await lookup(c.get("adminDb"), token);
    if (!admin) return reply(c, 401, "unauthorized", "Entre para continuar.");
    c.set("admin", admin);
    await next();
  };
}
