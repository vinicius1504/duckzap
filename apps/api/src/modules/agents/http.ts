import { can, type Permission } from "@duckzap/contracts/permissions";
import type { MemberRole, PlanSlug, SubscriptionStatus } from "@duckzap/contracts/session";
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
  plan: PlanSlug;
  subscriptionStatus: SubscriptionStatus;
};
export type ActorBindings = { Variables: AppBindings["Variables"] & { actor: Actor } };

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 502 | 503;

export function fail(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Resultado tipado dos casos de uso (sem Hono dentro do service). */
export type Res<T> = { ok: true; data: T } | { ok: false; status: ErrorStatus; code: string; message: string };
export const ok = <T>(data: T): Res<T> => ({ ok: true, data });
export const err = (status: ErrorStatus, code: string, message: string): Res<never> => ({ ok: false, status, code, message });

export async function parseBody<S extends z.ZodType>(
  c: Context,
  schemaToUse: S,
): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = schemaToUse.safeParse(raw);
  if (!parsed.success) return { ok: false, response: fail(c, 422, "validation_error", parsed.error.issues[0]?.message ?? "Confira os campos.") };
  return { ok: true, data: parsed.data };
}

/** Autentica, resolve empresa/papel e exige a permissão da matriz (a mesma do front). 401 sem sessão, 403 sem permissão. */
export function withActor(deps: Deps, permission: Permission): MiddlewareHandler<ActorBindings> {
  return async (c, next) => {
    const authSession = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!authSession) return fail(c, 401, "unauthorized", "Entre para continuar.");
    const built = await buildSession(deps.db, authSession);
    if (!built.ok) return fail(c, 403, "no_organization", "Termine o cadastro da sua empresa para continuar.");
    const { session } = built;
    const blocked = accessGate(session, c.req.path);
    if (blocked) return c.json(blocked.body, blocked.status);
    if (!can(session.user.role, permission)) {
      return fail(c, 403, "forbidden", "Você não tem permissão para fazer isso. Fale com um administrador.");
    }
    c.set("authSession", authSession);
    c.set("actor", {
      userId: session.user.id,
      organizationId: session.organization.id,
      role: session.user.role,
      name: session.user.name,
      plan: session.organization.plan,
      subscriptionStatus: session.organization.subscriptionStatus,
    });
    await next();
  };
}

export function respond<T>(c: Context, result: Res<T>, status: 200 | 201 = 200) {
  return result.ok ? c.json(result.data as object, status) : fail(c, result.status, result.code, result.message);
}
