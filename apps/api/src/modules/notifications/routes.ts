import { markNotificationsReadSchema } from "@duckzap/contracts/notifications";
import { withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings, Deps } from "../../lib/context";
import { jsonLimit, moduleErrorHandler, readJson, requestCtx, tenantGuard } from "../conversations/http";
import * as service from "./service";

/**
 * Notificações do sino. Só exigem sessão: cada pessoa vê e marca apenas as próprias.
 *
 *   GET  /notifications        { items (até 30, mais novas primeiro), unreadCount }
 *   POST /notifications/read   { all?: true, ids?: string[] } → { ok: true, unreadCount }
 */
export function notificationsRoutes(deps: Deps) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);

  app.get("/notifications", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await withOrg(deps.db, ctx.organizationId, (tx) => service.listNotifications(tx, ctx.organizationId, ctx.userId)));
  });

  app.post("/notifications/read", guard, jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, markNotificationsReadSchema);
    const { unreadCount } = await withOrg(deps.db, ctx.organizationId, (tx) => service.markRead(tx, ctx.organizationId, ctx.userId, body));
    return c.json({ ok: true, unreadCount });
  });

  return app;
}
