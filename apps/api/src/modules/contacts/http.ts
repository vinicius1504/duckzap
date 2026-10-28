import { can, type Permission } from "@duckzap/contracts/permissions";
import { isSendingPaused, type MemberRole, type Session } from "@duckzap/contracts/session";
import type { Context, ErrorHandler, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z, ZodType } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { formatZodError } from "../../lib/http-validation";
import { accessGate } from "../../middleware/account-gate";
import { onError } from "../../middleware/error-handler";
import { requireAuth } from "../../middleware/require-auth";
import { buildSession } from "../session/queries";
import type { Fail, ServiceCtx } from "./result";

// Cola HTTP compartilhada pelos módulos Clientes e Agenda: sessão → contexto do tenant → permissão → validação.
// Regra de negócio fica nos services; aqui só tradução de erros e entrada.

export type RequestCtx = ServiceCtx & { role: MemberRole; session: Session; sendingPaused: boolean };
export type ModuleBindings = AppBindings;
export type ModuleContext = Context<AppBindings>;

// O contexto do tenant fica numa tabela por requisição em vez de `c.set`: assim o sub-app mantém o tipo `AppBindings`
// que `app.route` exige. A chave é a sessão de autenticação da requisição (objeto estável; `c.req.raw` NÃO serve:
// o bodyLimit o substitui).
const requestContexts = new WeakMap<object, RequestCtx>();

export function requestCtx(c: ModuleContext): RequestCtx {
  const ctx = requestContexts.get(c.get("authSession"));
  if (!ctx) throw new ApiError(401, "unauthorized", "Entre para continuar.");
  return ctx;
}

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Erro de domínio (`error` do Result) → status HTTP. Desconhecido vira 422. */
const STATUS_BY_ERROR: Record<string, ContentfulStatusCode> = {
  not_found: 404,
  duplicate: 409,
  conflict: 409,
  segment: 409,
  funnel_stage: 409,
  invalid_transition: 409,
  disconnected: 409,
  too_large: 413,
  channel_not_found: 404,
  channel_disconnected: 409,
  provider_unavailable: 502,
};

export function failToError(result: Fail, extra: Record<string, unknown> = {}) {
  return new ApiError(STATUS_BY_ERROR[result.error] ?? 422, result.error, result.message, extra);
}

/** Entrega o dado de um Result ou lança o erro HTTP correspondente. */
export function unwrap<T>(result: { ok: true; data: T } | Fail): T {
  if (result.ok) return result.data;
  throw failToError(result);
}

/** `onError` do sub-app: ApiError vira `{ error: { code, message } }`; o resto cai no tratador global (500 genérico). */
export const moduleErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  return onError(err, c);
};

/** Exige sessão, empresa ativa e monta o contexto do tenant. O `organizationId` vem SEMPRE da sessão. */
export function tenantGuard(deps: Pick<Deps, "auth" | "db">): MiddlewareHandler<AppBindings> {
  const auth = requireAuth(deps);
  return async (c, next) => {
    // requireAuth devolve 401 sozinho; `next` só roda com sessão válida
    let passed = false;
    const early = await auth(c, async () => {
      passed = true;
    });
    if (!passed) return early;
    const result = await buildSession(deps.db, c.get("authSession"));
    if (!result.ok) throw new ApiError(403, "no_organization", "Termine o cadastro da sua empresa para continuar.");
    const { session } = result;
    const blocked = accessGate(session, c.req.path);
    if (blocked) return c.json(blocked.body, blocked.status);
    requestContexts.set(c.get("authSession"), {
      organizationId: session.organization.id,
      userId: session.user.id,
      userName: session.user.name,
      timeZone: session.organization.timeZone,
      orgName: session.organization.name,
      role: session.user.role,
      session,
      sendingPaused: isSendingPaused(session),
    });
    await next();
  };
}

/** Papel sem a permissão da matriz compartilhada → 403. */
export function permit(permission: Permission): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!can(requestCtx(c).role, permission)) {
      throw new ApiError(403, "forbidden", "Você não tem permissão para fazer isso. Fale com um administrador.");
    }
    await next();
  };
}

const tooBig = () => {
  throw new ApiError(413, "too_large", "O envio é grande demais.");
};
export const jsonLimit = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooBig });
export const uploadLimit = bodyLimit({ maxSize: 15 * 1024 * 1024, onError: tooBig });

function validationError(error: z.ZodError) {
  const failure = formatZodError(error);
  return new ApiError(422, "validation_error", failure.message, { fields: failure.fields });
}

export async function readJson<S extends ZodType>(c: ModuleContext, schema: S): Promise<z.output<S>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

export function parseWith<S extends ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value: string) => GUID.test(value);

/** Id de rota: formato inválido é "não existe" (404), nunca um erro de SQL. */
export function idParam(c: ModuleContext, name = "id"): string {
  const value = c.req.param(name) ?? "";
  if (!isGuid(value)) throw new ApiError(404, "not_found", "Não encontrado.");
  return value;
}
