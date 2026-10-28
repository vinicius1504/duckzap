import { can, type Permission } from "@duckzap/contracts/permissions";
import type { MemberRole, PlanSlug, SubscriptionStatus } from "@duckzap/contracts/session";
import { schema, withOrg } from "@duckzap/db";
import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import type { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { accessGate } from "../../middleware/account-gate";
import { buildSession } from "../session/queries";

/** Quem está chamando: tudo vem da sessão, nunca do corpo ou da URL (§3.4). */
export type Actor = {
  userId: string;
  organizationId: string;
  role: MemberRole;
  name: string;
  email: string;
  plan: PlanSlug;
  subscriptionStatus: SubscriptionStatus;
};

export type ActorBindings = { Variables: AppBindings["Variables"] & { actor: Actor } };

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Atalho para respostas de erro `{ error: { code, message } }` (message em pt-BR). */
export function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502, code: string, message: string) {
  return c.json(errorBody(code, message), status);
}

/** Lê e valida o corpo JSON; 422 com a primeira mensagem de validação. */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schemaToUse: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = schemaToUse.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: fail(c, 422, "validation_error", parsed.error.issues[0]?.message ?? "Confira os campos.") };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Autentica, resolve empresa/papel, barra pessoa inativa e (opcional) exige uma permissão da matriz.
 * Coloca o `actor` no contexto. Sem permissão → 403; sem sessão → 401.
 */
export function withActor(deps: Deps, permission?: Permission): MiddlewareHandler<ActorBindings> {
  return async (c, next) => {
    const authSession = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!authSession) return fail(c, 401, "unauthorized", "Entre para continuar.");
    const built = await buildSession(deps.db, authSession);
    if (!built.ok) return fail(c, 403, "no_organization", "Termine o cadastro da sua empresa para continuar.");
    const { session } = built;
    // conta suspensa e 2FA obrigatório (§5.1): allowlists mínimas em middleware/account-gate.ts
    const blocked = accessGate(session, c.req.path);
    if (blocked) return c.json(blocked.body, blocked.status);

    const [profile] = await withOrg(deps.db, session.organization.id, (tx) =>
      tx
        .select({ active: schema.memberProfiles.active })
        .from(schema.memberProfiles)
        .where(and(eq(schema.memberProfiles.organizationId, session.organization.id), eq(schema.memberProfiles.userId, session.user.id)))
        .limit(1),
    );
    if (profile && !profile.active) return fail(c, 403, "inactive_member", "Sua conta está inativa nesta empresa.");

    if (permission && !can(session.user.role, permission)) {
      return fail(c, 403, "forbidden", "Você não tem permissão para fazer isso. Fale com um administrador.");
    }

    c.set("authSession", authSession);
    c.set("actor", {
      userId: session.user.id,
      organizationId: session.organization.id,
      role: session.user.role,
      name: session.user.name,
      email: session.user.email,
      plan: session.organization.plan,
      subscriptionStatus: session.organization.subscriptionStatus,
    });
    await next();
  };
}

/** Copia os Set-Cookie de uma resposta do Better Auth para a resposta da nossa rota (a sessão pode ser renovada). */
export function forwardAuthCookies(from: Response, c: Context) {
  for (const cookie of from.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
}
