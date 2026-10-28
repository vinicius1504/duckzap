import { clientIp } from "../lib/client-ip";

/**
 * Cabeçalho INTERNO com o IP do cliente que o Better Auth usa para limitar tentativas (`advanced.ipAddress`).
 * O que vem de fora com esse nome é apagado e recalculado aqui por `clientIp` (socket / último item de x-forwarded-for).
 */
export const CLIENT_IP_HEADER = "x-dz-client-ip";

/**
 * Única superfície do Better Auth exposta por HTTP (§5): entrar, cadastrar, sair, sessão, senha e 2FA.
 * Todo o resto (`/organization/*`: criar/apagar empresa, convidar com papel livre, listar membros; `/update-user`,
 * `/delete-user`, `/change-email`, contas sociais etc.) NÃO é exposto: as regras do produto (plano, papéis, equipes)
 * vivem nas rotas próprias. Chamadas feitas direto pelo servidor (`auth.api.createOrganization(...)`) não passam por aqui.
 */
const EXACT_PATHS = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/sign-out",
  "/get-session",
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/ok",
  "/error",
]);
const PREFIX_PATHS = ["/two-factor/", "/reset-password/"];

export function isAllowedAuthPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "") || "/";
  return EXACT_PATHS.has(normalized) || PREFIX_PATHS.some((prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length);
}

/** Limite de tentativas por conta (e-mail). A interface é assíncrona para trocar a memória por Redis sem mudar quem usa. */
export interface LoginThrottle {
  isBlocked(key: string): Promise<boolean> | boolean;
  recordFailure(key: string): Promise<void> | void;
  reset(key: string): Promise<void> | void;
}

export function createMemoryLoginThrottle(options: { maxFailures?: number; windowMs?: number; now?: () => number } = {}): LoginThrottle {
  const maxFailures = options.maxFailures ?? 8;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; resetAt: number }>();
  return {
    isBlocked(key) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (entry.resetAt <= now()) {
        failures.delete(key);
        return false;
      }
      return entry.count >= maxFailures;
    },
    recordFailure(key) {
      const current = now();
      const entry = failures.get(key);
      if (!entry || entry.resetAt <= current) {
        failures.set(key, { count: 1, resetAt: current + windowMs });
        if (failures.size > 50_000) for (const [k, v] of failures) if (v.resetAt <= current) failures.delete(k);
        return;
      }
      entry.count += 1;
    },
    reset(key) {
      failures.delete(key);
    },
  };
}

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ code, message, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

async function emailOf(request: Request): Promise<string | null> {
  const body: unknown = await request.clone().json().catch(() => null);
  const email = (body as { email?: unknown } | null)?.email;
  return typeof email === "string" && email.length > 0 ? email.trim().toLowerCase().slice(0, 200) : null;
}

/**
 * Envolve `auth.handler`: (1) só deixa passar a superfície permitida; (2) grava o IP confiável no cabeçalho interno;
 * (3) limita tentativas de login POR CONTA além do limite por IP do Better Auth (8 falhas / 15 min por e-mail).
 */
export function guardAuthHandler(
  handler: (request: Request) => Promise<Response>,
  options: { basePath: string; trustProxy: boolean; loginThrottle?: LoginThrottle },
): (request: Request) => Promise<Response> {
  const throttle = options.loginThrottle ?? createMemoryLoginThrottle();
  return async (request) => {
    const url = new URL(request.url);
    const base = options.basePath.replace(/\/$/, "");
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    if (!isAllowedAuthPath(path)) return json(404, "NOT_FOUND", "Rota não encontrada.");

    // o e-mail é lido ANTES de reconstruir a requisição (o corpo de uma Request só pode ser consumido uma vez)
    const isSignIn = request.method === "POST" && path.replace(/\/+$/, "") === "/sign-in/email";
    const email = isSignIn ? await emailOf(request) : null;

    const headers = new Headers(request.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = clientIp({ headers: request.headers }, { trustProxy: options.trustProxy });
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    const forwarded = new Request(request, { headers });

    if (isSignIn) {
      if (email && (await throttle.isBlocked(email))) {
        return json(429, "TOO_MANY_ATTEMPTS", "Muitas tentativas. Aguarde alguns minutos e tente de novo.");
      }
      const response = await handler(forwarded);
      if (email) {
        if (response.ok) await throttle.reset(email);
        else if (response.status === 401 || response.status === 400 || response.status === 403) await throttle.recordFailure(email);
      }
      return response;
    }
    return handler(forwarded);
  };
}
