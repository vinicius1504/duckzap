import { can } from "@duckzap/contracts/permissions";
import { campaignDraftInputSchema, campaignMessageTypeSchema, generateVariationsInputSchema } from "@duckzap/contracts/campaigns";
import { schema, withOrg, type Transaction } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Deps } from "../../lib/context";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { isSendingPausedForOrg } from "../channels/sending";
import { fail, parseBody, withActor, type ActorBindings } from "../team/http";
import { loadCampaignsConfig } from "./config";
import { ensureCampaignInboundHandler } from "./inbound";
import { createCampaignsRuntime, setSharedCampaignsRuntime, type CampaignsRuntime } from "./ports";
import { loadOrgInfo, type CampaignCtx } from "./repo";
import { registerTickConsumer } from "./runner";
import * as service from "./service";

/**
 * Rotas finas de Campanhas: autenticar → autorizar (matriz de permissões) → plano → validar (Zod) → service.
 *   GET    /v1/campaigns                       lista                                   campaign.manage
 *   POST   /v1/campaigns                       cria rascunho                           campaign.manage
 *   GET    /v1/campaigns/history               concluídas e canceladas                 campaign.manage
 *   GET    /v1/campaigns/rejected              rejeitados (?campaignId=)               campaign.manage
 *   GET    /v1/campaigns/audiences             públicos + contagens                    campaign.manage
 *   GET    /v1/campaigns/channels              canais de envio (limites, aquecimento)  campaign.manage
 *   GET    /v1/campaigns/templates             modelos                                 campaign.manage
 *   POST   /v1/campaigns/templates             salva modelo interno                    campaign.manage
 *   DELETE /v1/campaigns/templates/:id         exclui modelo interno                   campaign.manage
 *   GET    /v1/campaigns/terms                 termos (versão e aceite)               campaign.manage
 *   POST   /v1/campaigns/terms/accept          aceita os termos                        campaign.manage + campaign.send
 *   POST   /v1/campaigns/variations            gera banco de variações (IA)            campaign.manage
 *   GET    /v1/campaigns/:id                   uma campanha                            campaign.manage
 *   PUT    /v1/campaigns/:id                   edita rascunho                          campaign.manage
 *   DELETE /v1/campaigns/:id                   exclui rascunho                         campaign.manage
 *   GET    /v1/campaigns/:id/recipients        envios                                  campaign.manage
 *   POST   /v1/campaigns/:id/launch            dispara                                 campaign.manage + campaign.send
 *   POST   /v1/campaigns/:id/pause             pausa                                   campaign.manage
 *   POST   /v1/campaigns/:id/resume            retoma                                  campaign.manage + campaign.send
 *   POST   /v1/campaigns/:id/cancel            cancela                                 campaign.manage
 *   POST   /v1/campaigns/:id/duplicate         duplica como rascunho                   campaign.manage
 * Plano sem o recurso `campaigns` (Básico) → 403 `plan_feature` em todas. Conta suspensa (expirada/cancelada) → 403 `account_suspended` (middleware, em todas); `sending_paused` só como segunda barreira
 * em disparar, retomar e aceitar termos (leitura e pausa/cancelamento continuam liberados).
 */

const STATUS: Record<string, 400 | 403 | 404 | 409 | 422 | 502> = {
  not_found: 404,
  not_draft: 409,
  invalid_state: 409,
  channel_unavailable: 409,
  read_only: 409,
  terms_required: 403,
  no_audience: 422,
  template_required: 422,
  variations_required: 422,
  invalid_message: 422,
  invalid_window: 422,
  invalid_schedule: 422,
  generation_failed: 502,
};

const templateInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome para o modelo.").max(60),
  type: campaignMessageTypeSchema,
  body: z.string().trim().min(1, "O modelo precisa de uma mensagem.").max(1024),
  buttons: z.array(z.string().trim().min(1).max(20)).max(3),
});

export function campaignsRoutes(deps: Deps, runtime?: CampaignsRuntime) {
  const rt = runtime ?? createCampaignsRuntime({ db: deps.db, llm: deps.llm });
  const config = loadCampaignsConfig();
  const app = new OpenAPIHono<ActorBindings>();
  // respostas a campanhas (SAIR, resposta, entregue/lida) — registrado uma vez por processo
  ensureCampaignInboundHandler(rt);
  registerTickConsumer(rt);
  setSharedCampaignsRuntime(rt); // o sweep de fundo (src/jobs.ts) usa o mesmo runtime
  const variationsLimiter = new InMemoryTokenBucket({ capacity: config.CAMPAIGNS_VARIATIONS_PER_MINUTE, refillPerSecond: config.CAMPAIGNS_VARIATIONS_PER_MINUTE / 60 });

  app.use("/campaigns/*", withActor(deps, "campaign.manage"));

  // plano: Campanhas só no Pro+ (recurso `campaigns` na tabela `plans`, §1.2) — vale para ler também
  const planLock: MiddlewareHandler<ActorBindings> = async (c, next) => {
    const [plan] = await deps.db.select({ features: schema.plans.features }).from(schema.plans).where(eq(schema.plans.slug, c.get("actor").plan)).limit(1);
    if (!plan?.features.includes("campaigns")) return fail(c, 403, "plan_feature", "Campanhas fazem parte dos planos Pro e Empresarial.");
    await next();
  };
  app.use("/campaigns/*", planLock);

  const run = <T>(c: Context<ActorBindings>, fn: (tx: Transaction, ctx: CampaignCtx) => Promise<T>) => {
    const actor = c.get("actor");
    return withOrg(deps.db, actor.organizationId, async (tx) => {
      const org = await loadOrgInfo(tx, actor.organizationId);
      return fn(tx, { organizationId: actor.organizationId, userId: actor.userId, userName: actor.name, timeZone: org.timeZone, orgName: org.name });
    });
  };

  /** Disparar, retomar e aceitar termos exigem `campaign.send` E assinatura em dia (checado no servidor). */
  const sendGuard = async (c: Context<ActorBindings>) => {
    const actor = c.get("actor");
    if (!can(actor.role, "campaign.send")) return fail(c, 403, "forbidden", "Só administradores podem disparar campanhas.");
    const paused = await withOrg(deps.db, actor.organizationId, (tx) => isSendingPausedForOrg(tx, rt.now()));
    if (paused) return fail(c, 403, "sending_paused", "Seu plano expirou. Os envios ficam pausados até a assinatura ser renovada.");
    return null;
  };

  const respond = <T>(c: Context<ActorBindings>, result: { ok: true; data: T } | { ok: false; error: string; message: string }, status: 200 | 201 = 200) => {
    if (result.ok) return c.json((result.data ?? { ok: true }) as object, status);
    return fail(c, STATUS[result.error] ?? 422, result.error, result.message);
  };

  // ---- rotas estáticas ANTES de /campaigns/:id ----
  app.get("/campaigns", async (c) => c.json(await run(c, (tx, ctx) => service.listCampaigns(tx, ctx, rt))));

  app.post("/campaigns", async (c) => {
    const body = await parseBody(c, campaignDraftInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await run(c, (tx, ctx) => service.createDraft(tx, ctx, rt, body.data)), 201);
  });

  app.get("/campaigns/history", async (c) => c.json(await run(c, (tx, ctx) => service.listHistory(tx, ctx, rt))));

  app.get("/campaigns/rejected", async (c) => {
    const campaignId = c.req.query("campaignId");
    return c.json(await run(c, (tx, ctx) => service.listRejected(tx, ctx, campaignId || undefined)));
  });

  app.get("/campaigns/audiences", async (c) => c.json(await run(c, (tx, ctx) => service.listAudiences(tx, ctx, rt))));
  app.get("/campaigns/channels", async (c) => c.json(await run(c, (tx, ctx) => service.listSendingChannels(tx, ctx, rt))));
  app.get("/campaigns/templates", async (c) => c.json(await run(c, (tx, ctx) => service.listTemplates(tx, ctx))));

  app.post("/campaigns/templates", async (c) => {
    const body = await parseBody(c, templateInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await run(c, (tx, ctx) => service.saveTemplate(tx, ctx, body.data)), 201);
  });

  app.delete("/campaigns/templates/:id", async (c) => respond(c, await run(c, (tx, ctx) => service.deleteTemplate(tx, ctx, c.req.param("id")))));

  app.get("/campaigns/terms", async (c) => c.json(await run(c, (tx, ctx) => service.getTerms(tx, ctx))));

  app.post("/campaigns/terms/accept", async (c) => {
    const blocked = await sendGuard(c);
    if (blocked) return blocked;
    return c.json(await run(c, (tx, ctx) => service.acceptTerms(tx, ctx)));
  });

  app.post("/campaigns/variations", async (c) => {
    const body = await parseBody(c, generateVariationsInputSchema);
    if (!body.ok) return body.response;
    const actor = c.get("actor");
    const taken = await variationsLimiter.take(actor.organizationId);
    if (!taken.allowed) return fail(c, 429, "rate_limited", "Muitas gerações em pouco tempo. Aguarde um minuto e tente de novo.");
    return respond(c, await service.generateVariations(rt, { organizationId: actor.organizationId }, body.data));
  });

  // ---- por id ----
  app.get("/campaigns/:id", async (c) => {
    const campaign = await run(c, (tx, ctx) => service.getCampaign(tx, ctx, rt, c.req.param("id")));
    return campaign ? c.json(campaign) : fail(c, 404, "not_found", "Campanha não encontrada.");
  });

  app.put("/campaigns/:id", async (c) => {
    const body = await parseBody(c, campaignDraftInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await run(c, (tx, ctx) => service.updateDraft(tx, ctx, rt, c.req.param("id"), body.data)));
  });

  app.delete("/campaigns/:id", async (c) => respond(c, await run(c, (tx, ctx) => service.deleteDraft(tx, ctx, c.req.param("id")))));

  app.get("/campaigns/:id/recipients", async (c) => respond(c, await run(c, (tx, ctx) => service.listRecipients(tx, ctx, c.req.param("id")))));

  app.post("/campaigns/:id/launch", async (c) => {
    const blocked = await sendGuard(c);
    if (blocked) return blocked;
    const result = await run(c, (tx, ctx) => service.launchCampaign(tx, ctx, rt, c.req.param("id")));
    if (result.ok) {
      // acorda o motor no instante do primeiro envio (job atrasado; em memória hoje, BullMQ no worker)
      const at = result.data.nextSendAt ? new Date(result.data.nextSendAt) : rt.now();
      void rt.queue.enqueue("campaign.tick", { organizationId: c.get("actor").organizationId, campaignId: result.data.id }, { delayMs: Math.max(0, at.getTime() - rt.now().getTime()), jobId: `${result.data.id}:${at.getTime()}` });
    }
    return respond(c, result);
  });

  app.post("/campaigns/:id/pause", async (c) => respond(c, await run(c, (tx, ctx) => service.pauseCampaign(tx, ctx, rt, c.req.param("id")))));

  app.post("/campaigns/:id/resume", async (c) => {
    const blocked = await sendGuard(c);
    if (blocked) return blocked;
    const result = await run(c, (tx, ctx) => service.resumeCampaign(tx, ctx, rt, c.req.param("id")));
    if (result.ok && result.data.nextSendAt) {
      const at = new Date(result.data.nextSendAt);
      void rt.queue.enqueue("campaign.tick", { organizationId: c.get("actor").organizationId, campaignId: result.data.id }, { delayMs: Math.max(0, at.getTime() - rt.now().getTime()), jobId: `${result.data.id}:${at.getTime()}` });
    }
    return respond(c, result);
  });

  app.post("/campaigns/:id/cancel", async (c) => respond(c, await run(c, (tx, ctx) => service.cancelCampaign(tx, ctx, rt, c.req.param("id")))));

  app.post("/campaigns/:id/duplicate", async (c) => respond(c, await run(c, (tx, ctx) => service.duplicateCampaign(tx, ctx, rt, c.req.param("id"))), 201));

  return app;
}
