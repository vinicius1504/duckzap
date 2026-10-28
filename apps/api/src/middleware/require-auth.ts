import type { MiddlewareHandler } from "hono";
import type { AppBindings, Deps } from "../lib/context";
import { buildSession } from "../modules/session/queries";
import { accessGate } from "./account-gate";

/**
 * Exige sessão válida (cookie do Better Auth) e a deixa em `c.get("authSession")`. Também aplica `accessGate`:
 * conta suspensa (403 `account_suspended`) e Proprietário/Administrador sem 2FA (403 `two_factor_required`, §5.1),
 * com allowlists mínimas (`/v1/me`, `/v1/account*`, `/v1/onboarding*`...). Sem `db` (testes que só querem a sessão) a checagem não roda.
 */
export function requireAuth({ auth, db }: Pick<Deps, "auth"> & Partial<Pick<Deps, "db">>): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      return c.json({ error: { code: "unauthorized", message: "Entre para continuar." } }, 401);
    }
    if (db) {
      const built = await buildSession(db, session);
      if (built.ok) {
        const blocked = accessGate(built.session, c.req.path);
        if (blocked) return c.json(blocked.body, blocked.status);
      }
    }
    c.set("authSession", session);
    await next();
  };
}
