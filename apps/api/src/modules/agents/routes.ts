import {
  agentConfigSchema,
  agentGeneratorInputSchema,
  agentStatusInputSchema,
  copilotFeedbackInputSchema,
  copilotToggleInputSchema,
  createAgentInputSchema,
  rollbackInputSchema,
  simulateInputSchema,
  uploadDocumentInputSchema,
} from "@duckzap/contracts/agents";
import { createConversationRateLimiter, type LlmRetryOptions } from "@duckzap/ai";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings, Deps } from "../../lib/context";
import { loadAgentsConfig } from "./config";
import { formatGeneratorIssues, generateAgent } from "./generate";
import { fail, parseBody, respond, withActor, type ActorBindings } from "./http";
import * as service from "./service";

/**
 * Rotas finas de Agentes: autenticar → autorizar (`agent.manage`) → validar (Zod) → service → serializar.
 *   GET    /v1/agents                              lista                          agent.manage
 *   POST   /v1/agents                              cria (limites de plano)        agent.manage
 *   GET    /v1/agents/channels                     canais para vincular           agent.manage
 *   GET    /v1/agents/appointment-types            tipos da Agenda                agent.manage
 *   GET    /v1/agents/plan-usage                   uso do limite de agentes       agent.manage
 *   POST   /v1/agents/generate                     gera o conteúdo do agente (SEM gravar) agent.manage
 *   GET    /v1/agents/:id                          um agente                      agent.manage
 *   PUT    /v1/agents/:id/config                   salva => NOVA versão           agent.manage
 *   GET    /v1/agents/:id/versions                 histórico                      agent.manage
 *   POST   /v1/agents/:id/rollback                 move o ponteiro de versão      agent.manage
 *   POST   /v1/agents/:id/status                   ativa/pausa/inativa            agent.manage
 *   POST   /v1/agents/:id/documents                metadados + texto              agent.manage
 *   DELETE /v1/agents/:id/documents/:documentId    remove                         agent.manage
 *   POST   /v1/agents/:id/simulate                 simulador (dry-run)            agent.manage
 *   GET    /v1/copilot                             visão geral                    agent.manage
 *   PUT    /v1/copilot                             liga/desliga (plano Empresarial) agent.manage
 *   POST   /v1/copilot/feedback                    útil/ruim numa sugestão        conversation.reply (quem atende)
 */
export type AgentsRoutesOptions = {
  /** Limite do gerador (injetável em teste). Padrão: AGENTS_GENERATOR_PER_MINUTE por empresa. */
  generatorLimit?: { allow(key: string): boolean };
  /** Esperas entre novas tentativas do provedor de IA no gerador (testes não esperam). */
  generatorRetry?: LlmRetryOptions;
};

export function agentsRoutes(deps: Deps, options: AgentsRoutesOptions = {}) {
  const app = new OpenAPIHono<ActorBindings>();
  const config = loadAgentsConfig();
  const simulatorLimit = createConversationRateLimiter({ max: config.AGENTS_SIMULATOR_PER_MINUTE, windowMs: 60_000 });
  const generatorLimit = options.generatorLimit ?? createConversationRateLimiter({ max: config.AGENTS_GENERATOR_PER_MINUTE, windowMs: 60_000 });

  app.use("/agents", withActor(deps, "agent.manage"));
  app.use("/agents/*", withActor(deps, "agent.manage"));
  app.use("/copilot", withActor(deps, "agent.manage"));
  app.use("/copilot/feedback", withActor(deps, "conversation.reply"));

  const ctx = (c: { get(key: "actor"): ActorBindings["Variables"]["actor"] }) => ({ deps, actor: c.get("actor"), config });
  const idOf = (raw: string) => raw.slice(0, 64);

  app.get("/agents", async (c) => c.json(await service.listAgents(ctx(c))));

  app.post("/agents", async (c) => {
    const body = await parseBody(c, createAgentInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.createAgent(ctx(c), body.data), 201);
  });

  // rotas estáticas ANTES de /agents/:id
  // gera o conteúdo do agente a partir dos dados da empresa; NÃO grava nada (o dono revisa e salva por POST /agents e PUT /agents/:id/config)
  app.post("/agents/generate", async (c) => {
    const raw: unknown = await c.req.json().catch(() => null);
    const parsed = agentGeneratorInputSchema.safeParse(raw);
    if (!parsed.success) {
      const { message, fields } = formatGeneratorIssues(parsed.error);
      return c.json({ error: { code: "invalid_input", message, fields } }, 422);
    }
    // cada geração gasta milhares de tokens do modelo "smart": limite por empresa
    if (!generatorLimit.allow(c.get("actor").organizationId)) {
      return fail(c, 429, "rate_limited", "Muitas gerações seguidas. Aguarde um minuto e tente de novo.");
    }
    return respond(c, await generateAgent(ctx(c), parsed.data, { retry: options.generatorRetry, signal: c.req.raw.signal }));
  });

  app.get("/agents/channels", async (c) => c.json(await service.listAgentChannels(ctx(c))));
  app.get("/agents/appointment-types", async (c) => c.json(await service.listAppointmentTypes(ctx(c))));
  app.get("/agents/plan-usage", async (c) => c.json(await service.getPlanUsage(ctx(c))));

  app.get("/agents/:id", async (c) => respond(c, await service.getAgent(ctx(c), idOf(c.req.param("id")))));

  app.put("/agents/:id/config", async (c) => {
    const body = await parseBody(c, agentConfigSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.updateAgentConfig(ctx(c), idOf(c.req.param("id")), body.data));
  });

  app.get("/agents/:id/versions", async (c) => respond(c, await service.listVersions(ctx(c), idOf(c.req.param("id")))));

  app.post("/agents/:id/rollback", async (c) => {
    const body = await parseBody(c, rollbackInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.rollbackAgentVersion(ctx(c), idOf(c.req.param("id")), body.data.versionId));
  });

  app.post("/agents/:id/status", async (c) => {
    const body = await parseBody(c, agentStatusInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.setAgentStatus(ctx(c), idOf(c.req.param("id")), body.data.status));
  });

  app.post("/agents/:id/documents", async (c) => {
    const body = await parseBody(c, uploadDocumentInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.uploadAgentDocument(ctx(c), idOf(c.req.param("id")), body.data), 201);
  });

  app.delete("/agents/:id/documents/:documentId", async (c) =>
    respond(c, await service.removeAgentDocument(ctx(c), idOf(c.req.param("id")), idOf(c.req.param("documentId")))),
  );

  app.post("/agents/:id/simulate", async (c) => {
    const body = await parseBody(c, simulateInputSchema);
    if (!body.ok) return body.response;
    // cada teste pode gastar tokens: limite por empresa
    if (!simulatorLimit.allow(c.get("actor").organizationId)) {
      return fail(c, 429, "rate_limited", "Muitos testes seguidos. Aguarde um minuto e tente de novo.");
    }
    return respond(c, await service.simulateAgent(ctx(c), idOf(c.req.param("id")), body.data));
  });

  app.get("/copilot", async (c) => c.json(await service.getCopilotOverview(ctx(c))));

  app.put("/copilot", async (c) => {
    const body = await parseBody(c, copilotToggleInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.setCopilotEnabled(ctx(c), body.data.enabled));
  });

  app.post("/copilot/feedback", async (c) => {
    const body = await parseBody(c, copilotFeedbackInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.recordCopilotFeedback(ctx(c), body.data), 201);
  });

  // o registro de módulos espera o ambiente base: embrulha (o `actor` é interno a este módulo)
  const root = new OpenAPIHono<AppBindings>();
  root.route("/", app);
  return root;
}
