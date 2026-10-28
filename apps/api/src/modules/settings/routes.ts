import { planSlugSchema } from "@duckzap/contracts/session";
import {
  changePasswordInputSchema,
  createApiKeyInputSchema,
  createWebhookInputSchema,
  notificationPrefsSchema,
  serviceSettingsSchema,
  totpCodeSchema,
  updateCompanyInputSchema,
  updateProfileInputSchema,
} from "@duckzap/contracts/settings";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { fail, parseBody, withActor, type ActorBindings } from "../team/http";
import type { Res } from "../team/result";
import * as account from "./account";
import * as apiKeys from "./api-keys";
import * as service from "./service";
import * as webhooks from "./webhooks";

const passwordBodySchema = z.object({ password: z.string().min(1, "Informe sua senha.").max(128) });

/**
 * Rotas finas de Ajustes. Permissões (matriz de `@duckzap/contracts/permissions`, igual ao front):
 *   settings.manage     GET|PUT /v1/settings/company · GET|PUT /v1/settings/service
 *   integration.manage  GET /v1/settings/integrations · POST …/google-calendar/(connect|disconnect)
 *                       POST …/instagram/authorize · PUT …/whatsapp-official/token
 *                       GET|POST /v1/settings/api-keys · DELETE /v1/settings/api-keys/:id
 *                       GET|POST /v1/settings/webhooks · POST …/:id/test · PATCH …/:id · DELETE …/:id
 *   billing.manage      GET /v1/settings/billing · POST /v1/settings/billing/plan-change
 *   só sessão           GET /v1/settings/plans · GET /v1/account · PATCH /v1/account/profile · PUT /v1/account/notifications
 *                       POST /v1/account/password · POST /v1/account/two-factor/(setup|confirm|disable)
 */
export function settingsRoutes(deps: Deps) {
  const app = new OpenAPIHono<ActorBindings>();

  app.use("/settings/company", withActor(deps, "settings.manage"));
  app.use("/settings/service", withActor(deps, "settings.manage"));
  app.use("/settings/integrations/*", withActor(deps, "integration.manage"));
  app.use("/settings/api-keys/*", withActor(deps, "integration.manage"));
  app.use("/settings/webhooks/*", withActor(deps, "integration.manage"));
  app.use("/settings/billing/*", withActor(deps, "billing.manage"));
  app.use("/settings/plans", withActor(deps));
  app.use("/account/*", withActor(deps));

  const send = <T>(c: Context, result: Res<T>, status: 200 | 201 = 200) =>
    result.ok ? c.json(result.data as object, status) : fail(c, result.error.status, result.error.code, result.error.message);
  const id = (c: Context) => c.req.param("id")?.slice(0, 64) ?? "";

  // ---------- Planos ----------
  app.get("/settings/plans", async (c) => c.json(await service.listPlans(deps)));

  // ---------- Empresa e Atendimento ----------
  app.get("/settings/company", async (c) => c.json(await service.getCompany({ deps, actor: c.get("actor") })));
  app.put("/settings/company", async (c) => {
    const body = await parseBody(c, updateCompanyInputSchema);
    if (!body.ok) return body.response;
    return send(c, await service.updateCompany({ deps, actor: c.get("actor") }, body.data));
  });

  app.get("/settings/service", async (c) => c.json(await service.getServiceSettings({ deps, actor: c.get("actor") })));
  app.put("/settings/service", async (c) => {
    const body = await parseBody(c, serviceSettingsSchema);
    if (!body.ok) return body.response;
    return c.json(await service.updateServiceSettings({ deps, actor: c.get("actor") }, body.data));
  });

  // ---------- Integrações ----------
  app.get("/settings/integrations", async (c) => c.json(await service.getIntegrations({ deps, actor: c.get("actor") })));
  app.post("/settings/integrations/google-calendar/connect", async (c) => {
    await service.connectGoogleCalendar({ deps, actor: c.get("actor") });
    return c.json({ ok: true });
  });
  app.post("/settings/integrations/google-calendar/disconnect", async (c) => {
    await service.disconnectGoogleCalendar({ deps, actor: c.get("actor") });
    return c.json({ ok: true });
  });
  app.post("/settings/integrations/instagram/authorize", async (c) => {
    const result = await service.authorizeInstagram({ deps, actor: c.get("actor") });
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });
  app.put("/settings/integrations/whatsapp-official/token", async (c) => {
    const body = await parseBody(c, z.object({ accessToken: z.string().trim().min(20, "Cole o token de acesso completo.").max(512) }));
    if (!body.ok) return body.response;
    const result = await service.updateWhatsappOfficialToken({ deps, actor: c.get("actor") }, body.data.accessToken);
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });

  // ---------- Chaves de API ----------
  app.get("/settings/api-keys", async (c) => c.json(await apiKeys.listApiKeys(deps, c.get("actor").organizationId)));
  app.post("/settings/api-keys", async (c) => {
    const body = await parseBody(c, createApiKeyInputSchema);
    if (!body.ok) return body.response;
    return c.json(await apiKeys.createApiKey(deps, c.get("actor").organizationId, body.data), 201);
  });
  app.delete("/settings/api-keys/:id", async (c) => {
    const result = await apiKeys.revokeApiKey(deps, c.get("actor").organizationId, id(c));
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });

  // ---------- Webhooks de saída ----------
  app.get("/settings/webhooks", async (c) => c.json(await webhooks.listWebhooks(deps, c.get("actor").organizationId)));
  app.post("/settings/webhooks", async (c) => {
    const body = await parseBody(c, createWebhookInputSchema);
    if (!body.ok) return body.response;
    return send(c, await webhooks.createWebhook(deps, c.get("actor").organizationId, body.data), 201);
  });
  app.post("/settings/webhooks/:id/test", async (c) => send(c, await webhooks.testWebhook(deps, c.get("actor").organizationId, id(c))));
  app.patch("/settings/webhooks/:id", async (c) => {
    const body = await parseBody(c, z.object({ active: z.boolean() }));
    if (!body.ok) return body.response;
    const result = await webhooks.setWebhookActive(deps, c.get("actor").organizationId, id(c), body.data.active);
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });
  app.delete("/settings/webhooks/:id", async (c) => {
    const result = await webhooks.deleteWebhook(deps, c.get("actor").organizationId, id(c));
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });

  // ---------- Plano e cobrança ----------
  app.get("/settings/billing", async (c) => c.json(await service.getBilling({ deps, actor: c.get("actor") })));
  app.post("/settings/billing/plan-change", async (c) => {
    const body = await parseBody(c, z.object({ plan: planSlugSchema }));
    if (!body.ok) return body.response;
    return send(c, await service.requestPlanChange({ deps, actor: c.get("actor") }, body.data.plan));
  });

  // ---------- Minha conta (só sessão) ----------
  const ctx = (c: Context<ActorBindings>) => ({ deps, actor: c.get("actor"), headers: c.req.raw.headers });
  const withCookies = <T>(c: Context<ActorBindings>, result: Res<account.WithCookies<T>>) => {
    if (!result.ok) return fail(c, result.error.status, result.error.code, result.error.message);
    for (const cookie of result.data.setCookies) c.header("set-cookie", cookie, { append: true });
    return c.json(result.data.value === null ? { ok: true } : (result.data.value as object));
  };

  app.get("/account", async (c) => c.json(await account.getAccount({ deps, actor: c.get("actor") })));
  app.patch("/account/profile", async (c) => {
    const body = await parseBody(c, updateProfileInputSchema);
    if (!body.ok) return body.response;
    const result = await account.updateProfile({ deps, actor: c.get("actor") }, body.data);
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });
  app.put("/account/notifications", async (c) => {
    const body = await parseBody(c, notificationPrefsSchema);
    if (!body.ok) return body.response;
    const result = await account.updateNotifications({ deps, actor: c.get("actor") }, body.data);
    return result.ok ? c.json({ ok: true }) : send(c, result);
  });
  app.post("/account/password", async (c) => {
    const body = await parseBody(c, changePasswordInputSchema);
    if (!body.ok) return body.response;
    return withCookies(c, await account.changePassword(ctx(c), body.data));
  });
  app.post("/account/two-factor/setup", async (c) => {
    const body = await parseBody(c, passwordBodySchema);
    if (!body.ok) return body.response;
    return withCookies(c, await account.startTwoFactorSetup(ctx(c), body.data.password));
  });
  app.post("/account/two-factor/confirm", async (c) => {
    const body = await parseBody(c, z.object({ code: totpCodeSchema }));
    if (!body.ok) return body.response;
    return withCookies(c, await account.confirmTwoFactor(ctx(c), body.data.code));
  });
  app.post("/account/two-factor/disable", async (c) => {
    const body = await parseBody(c, passwordBodySchema);
    if (!body.ok) return body.response;
    return withCookies(c, await account.disableTwoFactor(ctx(c), body.data.password));
  });

  const outer = new OpenAPIHono<AppBindings>();
  outer.route("/", app);
  return outer;
}
