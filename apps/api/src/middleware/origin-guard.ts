import type { MiddlewareHandler } from "hono";
import type { AppBindings, Deps } from "../lib/context";
import { loadAdminConfig } from "../modules/admin/config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Tipos de corpo que um <form> de outro site consegue enviar sem pré-voo CORS. */
const FORM_CONTENT_TYPES = /^(application\/x-www-form-urlencoded|text\/plain)\b/i;
/** O painel admin tem a própria guarda (adminGuard); os webhooks vêm dos provedores, sem Origin e sem cookie. */
const SKIPPED = /^\/v1\/(admin|webhooks)(\/|$)/;

export type OriginDecision = { allowed: true } | { allowed: false; status: 403 | 415; code: string; message: string };

/** Regra pura (testável): o que fazer com uma requisição que altera dado. */
export function checkOrigin(input: {
  method: string;
  path: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  contentType: string | undefined;
  allowedOrigins: readonly string[];
}): OriginDecision {
  if (SAFE_METHODS.has(input.method.toUpperCase()) || SKIPPED.test(input.path)) return { allowed: true };
  if (input.origin !== undefined && !input.allowedOrigins.includes(input.origin)) {
    return { allowed: false, status: 403, code: "forbidden_origin", message: "Origem não permitida." };
  }
  // sem Origin = cliente que não é navegador (servidor do front, curl); navegador que se declara "cross-site" é barrado
  if (input.origin === undefined && input.secFetchSite === "cross-site") {
    return { allowed: false, status: 403, code: "forbidden_origin", message: "Origem não permitida." };
  }
  if (input.contentType && FORM_CONTENT_TYPES.test(input.contentType)) {
    return { allowed: false, status: 415, code: "unsupported_media_type", message: "Envie os dados em JSON." };
  }
  return { allowed: true };
}

/**
 * Defesa extra contra CSRF (além do SameSite do cookie): toda requisição que altera dado precisa vir de uma origem
 * conhecida (`WEB_ORIGINS` + `ADMIN_ORIGINS`) e não pode ser um envio de formulário clássico.
 * Aplicar em `app.ts`: `app.use("/v1/*", originGuard(deps));`
 */
export function originGuard({ env }: Pick<Deps, "env">): MiddlewareHandler<AppBindings> {
  const allowedOrigins = [...env.WEB_ORIGINS, ...loadAdminConfig().ADMIN_ORIGINS];
  return async (c, next) => {
    const decision = checkOrigin({
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header("origin"),
      secFetchSite: c.req.header("sec-fetch-site"),
      contentType: c.req.header("content-type"),
      allowedOrigins,
    });
    if (!decision.allowed) return c.json({ error: { code: decision.code, message: decision.message } }, decision.status);
    await next();
  };
}
