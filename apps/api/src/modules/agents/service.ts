import { tokenBudget, type AppointmentTypeInfo, type UsageEvent } from "@duckzap/ai";
import {
  MAX_DOCUMENT_BYTES,
  agentConfigSchema,
  type Agent,
  type AgentConfig,
  type AgentChannel,
  type AgentPlanUsage,
  type AgentStatus,
  type AgentTool,
  type AgentVersion,
  type AppointmentType,
  type CopilotFeedbackInput,
  type CopilotOverview,
  type CreateAgentInput,
  type KnowledgeDocument,
  type SimulateInput,
  type SimulatorReply,
  type UploadDocumentInput,
} from "@duckzap/contracts/agents";
import { schema, withOrg, type Transaction } from "@duckzap/db";
import { and, asc, count, desc, eq, gte, inArray, max, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Deps } from "../../lib/context";
import { resolvePlan, tokenLimitValue } from "../../lib/plan";
import { channelIdsByAgent, setAgentChannels, teamNamesByAgent } from "../channels/links";
import { chunkText, documentKind } from "./chunking";
import type { AgentsConfig } from "./config";
import { err, ok, type Actor, type Res } from "./http";
import { createDbKnowledgePort } from "./knowledge-store";
import { checkCanActivate, checkCanCreateAgent, checkCopilotAllowed, effectiveStatus, type PlanInfo } from "./plan";
import { simulateReply } from "./simulate";

/**
 * Casos de uso de Agentes. Sem Hono. Toda leitura/escrita roda em `withOrg(db, actor.organizationId, …)`:
 * o organizationId vem da sessão (RLS + filtro explícito). Agente de outra empresa = 404 (não revela existência).
 */
export type Ctx = { deps: Deps; actor: Actor; config: AgentsConfig };

const uuid = z.uuid();
const isUuid = (v: string) => uuid.safeParse(v).success;
const MAX_DOCS_PER_AGENT = 20;
const MAX_CHUNKS_PER_DOC = 500;
const NOT_FOUND = () => err(404, "not_found", "Agente não encontrado.");

type AgentRow = typeof schema.agents.$inferSelect;

/** Limites do plano da empresa (fonte única: `lib/plan.ts`). null em `maxAgents` = ilimitado; sem plano = nada liberado. */
async function planOf(tx: Transaction, actor: Actor): Promise<PlanInfo> {
  const plan = await resolvePlan(tx, actor.organizationId);
  return { maxAgents: plan.limits.agents, features: plan.features };
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function parseConfig(value: unknown): AgentConfig {
  return agentConfigSchema.parse(value);
}

// ---------- montagem do Agent (contrato) ----------

async function loadAgents(tx: Transaction, actor: Actor, plan: PlanInfo, onlyId?: string): Promise<Agent[]> {
  const rows = await tx
    .select({ agent: schema.agents, config: schema.agentVersions.config })
    .from(schema.agents)
    .innerJoin(
      schema.agentVersions,
      and(eq(schema.agentVersions.agentId, schema.agents.id), eq(schema.agentVersions.number, schema.agents.currentVersion)),
    )
    .where(and(eq(schema.agents.organizationId, actor.organizationId), onlyId ? eq(schema.agents.id, onlyId) : undefined))
    .orderBy(asc(schema.agents.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.agent.id);

  const docs = await tx
    .select({
      id: schema.agentDocuments.id,
      agentId: schema.agentDocuments.agentId,
      name: schema.agentDocuments.name,
      kind: schema.agentDocuments.kind,
      sizeBytes: schema.agentDocuments.sizeBytes,
      pages: schema.agentDocuments.pages,
      status: schema.agentDocuments.status,
      error: schema.agentDocuments.error,
      uploadedAt: schema.agentDocuments.uploadedAt,
    })
    .from(schema.agentDocuments)
    .where(and(eq(schema.agentDocuments.organizationId, actor.organizationId), inArray(schema.agentDocuments.agentId, ids)))
    .orderBy(desc(schema.agentDocuments.uploadedAt));

  // canais e equipes do agente: derivados de `channels.agent_id`/`channels.team_id` (única fonte de verdade)
  const channelsByAgent = await channelIdsByAgent(tx, actor.organizationId);
  const teamsByAgent = await teamNamesByAgent(tx, actor.organizationId);
  const channelIds = [...new Set([...channelsByAgent.values()].flat())];
  const channelRows = channelIds.length
    ? await tx
        .select({ id: schema.channels.id, name: schema.channels.name, type: schema.channels.type })
        .from(schema.channels)
        .where(and(eq(schema.channels.organizationId, actor.organizationId), inArray(schema.channels.id, channelIds)))
    : [];
  const channelById = new Map(channelRows.map((c) => [c.id, c]));

  const since = new Date(Date.now() - 7 * 24 * 3_600_000);
  const events = await tx
    .select({ agentId: schema.conversationAiEvents.agentId, conversationId: schema.conversationAiEvents.conversationId, to: schema.conversationAiEvents.toState })
    .from(schema.conversationAiEvents)
    .where(
      and(
        eq(schema.conversationAiEvents.organizationId, actor.organizationId),
        gte(schema.conversationAiEvents.createdAt, since),
        inArray(schema.conversationAiEvents.agentId, ids),
      ),
    )
    .groupBy(schema.conversationAiEvents.agentId, schema.conversationAiEvents.conversationId, schema.conversationAiEvents.toState);

  return rows.map(({ agent, config }) => {
    const channels: AgentChannel[] = (channelsByAgent.get(agent.id) ?? []).flatMap((id) => {
      const c = channelById.get(id);
      const kind = c?.type;
      return c && (kind === "whatsapp_qr" || kind === "whatsapp_official" || kind === "instagram") ? [{ id: c.id, name: c.name, kind }] : [];
    });
    const teams = [...new Set([...agent.teams, ...(teamsByAgent.get(agent.id) ?? [])])];
    const mine = events.filter((e) => e.agentId === agent.id);
    const conversations = new Set(mine.map((e) => e.conversationId));
    const handedOff = new Set(mine.filter((e) => e.to === "handoff_requested").map((e) => e.conversationId));
    const stored = {
      status: agent.status as AgentStatus,
      pausedReason: agent.pausedReason === "plan_feature" || agent.pausedReason === "manual" ? agent.pausedReason : null,
    } as const;
    const effective = effectiveStatus(stored, agent.job as Agent["job"], plan);
    return {
      id: agent.id,
      job: agent.job as Agent["job"],
      status: effective.status,
      isDefault: agent.isDefault,
      teams,
      channels,
      config: parseConfig(config),
      documents: docs.filter((d) => d.agentId === agent.id).map(toDocument),
      currentVersion: agent.currentVersion,
      pausedReason: effective.pausedReason,
      stats: {
        conversationsLast7d: conversations.size,
        handoffRatePercent: conversations.size ? Math.round((handedOff.size / conversations.size) * 100) : 0,
      },
      updatedAt: iso(agent.updatedAt),
    };
  });
}

function toDocument(d: {
  id: string;
  name: string;
  kind: string;
  sizeBytes: number;
  pages: number | null;
  status: string;
  error: string | null;
  uploadedAt: Date;
}): KnowledgeDocument {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind === "pdf" || d.kind === "docx" ? d.kind : "txt",
    sizeBytes: d.sizeBytes,
    pages: d.pages,
    status: d.status === "ready" || d.status === "failed" ? d.status : "processing",
    error: d.error,
    uploadedAt: iso(d.uploadedAt),
  };
}

async function findAgentRow(tx: Transaction, actor: Actor, id: string): Promise<AgentRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, id), eq(schema.agents.organizationId, actor.organizationId)))
    .limit(1);
  return row ?? null;
}

// ---------- leitura ----------

export async function listAgents({ deps, actor }: Ctx): Promise<Agent[]> {
  return withOrg(deps.db, actor.organizationId, async (tx) => loadAgents(tx, actor, await planOf(tx, actor)));
}

export async function getAgent({ deps, actor }: Ctx, id: string): Promise<Res<Agent>> {
  if (!isUuid(id)) return NOT_FOUND();
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const [agent] = await loadAgents(tx, actor, await planOf(tx, actor), id);
    return agent ? ok(agent) : NOT_FOUND();
  });
}

/** Canais da empresa (leitura da tabela de Canais) para o seletor do agente. */
export async function listAgentChannels({ deps, actor }: Ctx): Promise<AgentChannel[]> {
  const rows = await withOrg(deps.db, actor.organizationId, (tx) =>
    tx
      .select({ id: schema.channels.id, name: schema.channels.name, type: schema.channels.type })
      .from(schema.channels)
      .where(eq(schema.channels.organizationId, actor.organizationId))
      .orderBy(asc(schema.channels.name)),
  );
  return rows.flatMap((c) => (c.type === "whatsapp_qr" || c.type === "whatsapp_official" || c.type === "instagram" ? [{ id: c.id, name: c.name, kind: c.type }] : []));
}

/** Tipos de atendimento da Agenda. `staffOnly` nunca pode ser liberado ao agente. */
export async function listAppointmentTypes({ deps, actor }: Ctx): Promise<AppointmentType[]> {
  const rows = await withOrg(deps.db, actor.organizationId, (tx) =>
    tx
      .select()
      .from(schema.appointmentTypes)
      .where(and(eq(schema.appointmentTypes.organizationId, actor.organizationId), eq(schema.appointmentTypes.active, true)))
      .orderBy(asc(schema.appointmentTypes.name)),
  );
  return rows.map((t) => ({ id: t.id, name: t.name, durationMinutes: t.durationMinutes, staffOnly: t.staffOnly }));
}

export async function getPlanUsage({ deps, actor }: Ctx): Promise<AgentPlanUsage> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const plan = await planOf(tx, actor);
    const [row] = await tx.select({ n: count() }).from(schema.agents).where(eq(schema.agents.organizationId, actor.organizationId));
    return { agents: row?.n ?? 0, maxAgents: plan.maxAgents };
  });
}

export async function listVersions({ deps, actor }: Ctx, agentId: string): Promise<Res<AgentVersion[]>> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, agentId);
    if (!agent) return NOT_FOUND();
    const rows = await tx
      .select()
      .from(schema.agentVersions)
      .where(and(eq(schema.agentVersions.agentId, agentId), eq(schema.agentVersions.organizationId, actor.organizationId)))
      .orderBy(desc(schema.agentVersions.number));
    return ok(
      rows.map((v) => ({ id: v.id, agentId: v.agentId, number: v.number, createdAt: iso(v.createdAt), createdBy: v.createdBy, summary: v.summary, config: parseConfig(v.config) })),
    );
  });
}

// ---------- escrita ----------

const jobDefaults: Record<Agent["job"], { description: string; tools: AgentTool[]; canBook: boolean }> = {
  support: { description: "Atende clientes, tira dúvidas e chama a equipe quando precisa", tools: ["search_knowledge", "request_human", "add_tag"], canBook: false },
  follow_up: { description: "Retoma conversas paradas no tempo certo", tools: ["search_knowledge", "request_human", "schedule_followup"], canBook: false },
  scheduling: { description: "Marca e remarca horários na Agenda", tools: ["list_available_slots", "book_appointment", "reschedule_appointment", "request_human"], canBook: true },
  instagram_dm: { description: "Responde o Direct do Instagram", tools: ["search_knowledge", "request_human"], canBook: false },
  comments: { description: "Responde comentários públicos do Instagram", tools: ["search_knowledge", "request_human"], canBook: false },
};

export async function createAgent({ deps, actor }: Ctx, input: CreateAgentInput): Promise<Res<Agent>> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const plan = await planOf(tx, actor);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(schema.agents).where(eq(schema.agents.organizationId, actor.organizationId));
    const check = checkCanCreateAgent(plan, n, input.job);
    if (!check.ok) return err(403, check.code, check.message);

    const requested = [...new Set(input.channelIds)];
    if (requested.length) {
      const valid = requested.filter(isUuid);
      const found = valid.length
        ? await tx
            .select({ id: schema.channels.id })
            .from(schema.channels)
            .where(and(eq(schema.channels.organizationId, actor.organizationId), inArray(schema.channels.id, valid)))
        : [];
      if (found.length !== requested.length) return err(422, "channel_not_found", "Canal não encontrado.");
    }

    const [base] = await tx
      .select({ config: schema.agentVersions.config })
      .from(schema.agents)
      .innerJoin(schema.agentVersions, and(eq(schema.agentVersions.agentId, schema.agents.id), eq(schema.agentVersions.number, schema.agents.currentVersion)))
      .where(and(eq(schema.agents.organizationId, actor.organizationId), eq(schema.agents.isDefault, true)))
      .limit(1);
    const baseConfig = base ? parseConfig(base.config) : null;
    const defaults = jobDefaults[input.job];
    const config: AgentConfig = {
      name: input.name,
      profile: { description: defaults.description, tone: "friendly", companySummary: baseConfig?.profile.companySummary ?? "" },
      knowledge: { productsAndServices: baseConfig?.knowledge.productsAndServices ?? "", faq: baseConfig?.knowledge.faq ?? "" },
      behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
      followUp: { enabled: input.job === "follow_up", steps: [], respectBusinessHours: true, stopOnReply: true },
      scheduling: { canBook: false, appointmentTypeIds: [] },
      advanced: { prompt: `Você é ${input.name}, assistente da empresa. Responda em português, de forma clara. Nunca invente preços.`, tools: defaults.tools },
    };

    const id = uuidv7();
    await tx.insert(schema.agents).values({
      id,
      organizationId: actor.organizationId,
      job: input.job,
      status: "inactive",
      isDefault: n === 0,
      currentVersion: 1,
    });
    await tx.insert(schema.agentVersions).values({
      id: uuidv7(),
      organizationId: actor.organizationId,
      agentId: id,
      number: 1,
      config,
      summary: "Agente criado",
      createdBy: actor.name,
    });
    // vínculo agente↔canal: grava em `channels.agent_id` na mesma transação (valida que os canais são da empresa)
    const linked = await setAgentChannels(tx, actor.organizationId, id, requested);
    if (!linked.ok) return err(422, "channel_not_found", "Canal não encontrado.");
    const [agent] = await loadAgents(tx, actor, plan, id);
    return agent ? ok(agent) : NOT_FOUND();
  });
}

/** Resumo da versão (exportada para teste). `undefined` e "" contam como o mesmo (campo opcional ainda não preenchido). */
export function describeChange(before: AgentConfig, after: AgentConfig) {
  const parts: string[] = [];
  const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const text = (value: string | undefined) => (value ?? "").trim();
  const { companyInfo: beforeInfo, ...beforeKnowledge } = before.knowledge;
  const { companyInfo: afterInfo, ...afterKnowledge } = after.knowledge;
  const { restrictions: beforeRestrictions, ...beforeAdvanced } = before.advanced;
  const { restrictions: afterRestrictions, ...afterAdvanced } = after.advanced;
  if (before.name !== after.name || differs(before.profile, after.profile)) parts.push("perfil");
  if (text(beforeInfo) !== text(afterInfo)) parts.push("informações da empresa");
  if (differs(beforeKnowledge, afterKnowledge)) parts.push("conhecimento");
  if (differs(before.behavior, after.behavior)) parts.push("comportamento");
  if (differs(before.followUp, after.followUp)) parts.push("follow-up");
  if (differs(before.scheduling, after.scheduling)) parts.push("agenda");
  if (differs(beforeAdvanced, afterAdvanced)) parts.push("prompt e ferramentas");
  if (text(beforeRestrictions) !== text(afterRestrictions)) parts.push("restrições");
  if (differs(before.generator, after.generator)) parts.push("formulário do gerador");
  return parts.length ? `Alterou ${parts.join(", ")}` : "Salvo sem alterações";
}

/** Toda alteração cria uma versão nova (§4.3). `request_human` nunca pode ser desligada. */
export async function updateAgentConfig({ deps, actor }: Ctx, id: string, input: AgentConfig): Promise<Res<Agent>> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, id);
    if (!agent) return NOT_FOUND();
    // config.scheduling (tipos liberados) é legado e ignorado pelo runtime: a agenda vem dos tipos ativos da empresa, então não há o que validar aqui

    const tools: AgentTool[] = input.advanced.tools.includes("request_human") ? input.advanced.tools : [...input.advanced.tools, "request_human"];
    const next: AgentConfig = { ...input, advanced: { ...input.advanced, tools } };

    const [current] = await tx
      .select({ config: schema.agentVersions.config })
      .from(schema.agentVersions)
      .where(and(eq(schema.agentVersions.agentId, id), eq(schema.agentVersions.number, agent.currentVersion)))
      .limit(1);
    const [top] = await tx.select({ n: max(schema.agentVersions.number) }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, id));
    const number = (top?.n ?? agent.currentVersion) + 1;

    await tx.insert(schema.agentVersions).values({
      id: uuidv7(),
      organizationId: actor.organizationId,
      agentId: id,
      number,
      config: next,
      summary: current ? describeChange(parseConfig(current.config), next) : "Configuração salva",
      createdBy: actor.name,
    });
    await tx.update(schema.agents).set({ currentVersion: number, updatedAt: new Date() }).where(and(eq(schema.agents.id, id), eq(schema.agents.organizationId, actor.organizationId)));
    const [updated] = await loadAgents(tx, actor, await planOf(tx, actor), id);
    return updated ? ok(updated) : NOT_FOUND();
  });
}

/** Rollback = mover o ponteiro `current_version` para uma versão existente; o histórico nunca é apagado (§4.3). */
export async function rollbackAgentVersion({ deps, actor }: Ctx, id: string, versionId: string): Promise<Res<Agent>> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, id);
    if (!agent) return NOT_FOUND();
    if (!isUuid(versionId)) return err(404, "not_found", "Versão não encontrada.");
    const [version] = await tx
      .select({ number: schema.agentVersions.number })
      .from(schema.agentVersions)
      .where(and(eq(schema.agentVersions.id, versionId), eq(schema.agentVersions.agentId, id), eq(schema.agentVersions.organizationId, actor.organizationId)))
      .limit(1);
    if (!version) return err(404, "not_found", "Versão não encontrada.");
    await tx.update(schema.agents).set({ currentVersion: version.number, updatedAt: new Date() }).where(eq(schema.agents.id, id));
    const [updated] = await loadAgents(tx, actor, await planOf(tx, actor), id);
    return updated ? ok(updated) : NOT_FOUND();
  });
}

export async function setAgentStatus({ deps, actor }: Ctx, id: string, status: AgentStatus): Promise<Res<Agent>> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, id);
    if (!agent) return NOT_FOUND();
    const plan = await planOf(tx, actor);
    if (status === "active") {
      const check = checkCanActivate(plan, agent.job as Agent["job"]);
      if (!check.ok) return err(403, check.code, check.message);
      const linked = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(and(eq(schema.channels.organizationId, actor.organizationId), eq(schema.channels.agentId, agent.id)))
        .limit(1);
      if (linked.length === 0) return err(409, "no_channel", "Vincule o agente a um canal em Canais antes de ativar.");
    }
    await tx
      .update(schema.agents)
      .set({ status, pausedReason: status === "paused" ? "manual" : null, updatedAt: new Date() })
      .where(and(eq(schema.agents.id, id), eq(schema.agents.organizationId, actor.organizationId)));
    const [updated] = await loadAgents(tx, actor, plan, id);
    return updated ? ok(updated) : NOT_FOUND();
  });
}

// ---------- documentos de conhecimento ----------

/**
 * Upload (fase atual): metadados + texto já extraído. Com texto → vira trechos pesquisáveis (status `ready`).
 * Sem texto (só nome/tamanho, como o front envia hoje) o arquivo NÃO pode ser lido ainda: `failed` com motivo claro.
 * Extração real de PDF/DOCX e upload do arquivo (URL assinada no R2) são a próxima etapa.
 */
export async function uploadAgentDocument(ctx: Ctx, id: string, input: UploadDocumentInput): Promise<Res<KnowledgeDocument>> {
  const { deps, actor, config } = ctx;
  const kind = documentKind(input.name);
  if (!kind) return err(422, "invalid_file", "Envie PDF, DOCX ou TXT.");
  if (input.sizeBytes > MAX_DOCUMENT_BYTES) return err(422, "invalid_file", "O arquivo passa de 10 MB.");
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, id);
    if (!agent) return NOT_FOUND();
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(schema.agentDocuments).where(eq(schema.agentDocuments.agentId, id));
    if (n >= MAX_DOCS_PER_AGENT) return err(422, "document_limit", `Cada agente aceita até ${MAX_DOCS_PER_AGENT} documentos.`);

    const text = input.text?.trim() ?? "";
    const chunks = chunkText(text, config.AGENTS_CHUNK_CHARS).slice(0, MAX_CHUNKS_PER_DOC);
    let status: "ready" | "failed" = "ready";
    let error: string | null = null;
    if (input.sizeBytes === 0) {
      status = "failed";
      error = "O arquivo está vazio.";
    } else if (chunks.length === 0) {
      status = "failed";
      error = "Não conseguimos ler o conteúdo deste arquivo ainda. Cole o texto em Conhecimento ou envie um TXT.";
    }
    const docId = uuidv7();
    const [row] = await tx
      .insert(schema.agentDocuments)
      .values({
        id: docId,
        organizationId: actor.organizationId,
        agentId: id,
        name: input.name,
        kind,
        sizeBytes: input.sizeBytes,
        pages: status === "ready" ? Math.max(1, Math.ceil(text.length / 3000)) : null,
        status,
        error,
        extractedText: status === "ready" ? text : null,
        createdBy: actor.name,
      })
      .returning();
    if (status === "ready") {
      for (let i = 0; i < chunks.length; i += 100) {
        await tx.insert(schema.knowledgeChunks).values(
          chunks.slice(i, i + 100).map((content, j) => ({
            id: uuidv7(),
            organizationId: actor.organizationId,
            agentId: id,
            documentId: docId,
            position: i + j,
            content,
          })),
        );
      }
    }
    if (!row) return err(409, "conflict", "Não foi possível salvar o documento.");
    return ok(toDocument(row));
  });
}

export async function removeAgentDocument({ deps, actor }: Ctx, id: string, documentId: string): Promise<Res<null>> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, id);
    if (!agent) return NOT_FOUND();
    if (!isUuid(documentId)) return err(404, "not_found", "Documento não encontrado.");
    const removed = await tx
      .delete(schema.agentDocuments)
      .where(and(eq(schema.agentDocuments.id, documentId), eq(schema.agentDocuments.agentId, id), eq(schema.agentDocuments.organizationId, actor.organizationId)))
      .returning({ id: schema.agentDocuments.id });
    return removed.length ? ok(null) : err(404, "not_found", "Documento não encontrado.");
  });
}

// ---------- simulador ----------

export async function monthlyTokens(tx: Transaction, actor: Actor) {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${schema.aiUsageLog.inputTokens} + ${schema.aiUsageLog.outputTokens}), 0)::float8` })
    .from(schema.aiUsageLog)
    .where(and(eq(schema.aiUsageLog.organizationId, actor.organizationId), gte(schema.aiUsageLog.createdAt, sql`date_trunc('month', now())`)));
  return row?.total ?? 0;
}

export async function simulateAgent(context: Ctx, id: string, input: SimulateInput): Promise<Res<SimulatorReply>> {
  const { deps, actor, config } = context;
  const last = input.history[input.history.length - 1];
  if (last?.role !== "customer") return err(422, "validation_error", "A última mensagem do teste precisa ser do cliente.");
  const prepared = await withOrg(deps.db, actor.organizationId, async (tx) => {
    const agent = await findAgentRow(tx, actor, id);
    if (!agent) return null;
    const types = await tx
      .select()
      .from(schema.appointmentTypes)
      .where(and(eq(schema.appointmentTypes.organizationId, actor.organizationId), eq(schema.appointmentTypes.active, true)));
    const used = await monthlyTokens(tx, actor);
    const tokenLimit = tokenLimitValue(await resolvePlan(tx, actor.organizationId));
    return { types, used, tokenLimit };
  });
  if (!prepared) return NOT_FOUND();

  const infos: AppointmentTypeInfo[] = prepared.types.map((t) => ({ id: t.id, name: t.name, durationMinutes: t.durationMinutes, staffOnly: t.staffOnly }));
  const events: UsageEvent[] = [];
  const budget = tokenBudget(prepared.used, prepared.tokenLimit);
  const reply = await simulateReply({
    llm: deps.llm,
    organizationId: actor.organizationId,
    agentId: id,
    config: input.config,
    history: input.history,
    knowledge: createDbKnowledgePort(deps.db),
    types: infos,
    remainingTokens: budget.remaining,
    urlAllowlist: config.AGENTS_URL_ALLOWLIST,
    onUsage: (e) => events.push(e),
  });
  await recordUsage(context, events, { agentId: id, conversationId: null });
  return ok(reply);
}

/** Registra tokens (sem conteúdo de mensagem) para orçamento e custos. Falha de log não derruba a resposta. */
export async function recordUsage({ deps, actor }: Ctx, events: UsageEvent[], scope: { agentId: string | null; conversationId: string | null }) {
  if (events.length === 0) return;
  try {
    await withOrg(deps.db, actor.organizationId, (tx) =>
      tx.insert(schema.aiUsageLog).values(
        events.map((e) => ({
          id: uuidv7(),
          organizationId: actor.organizationId,
          agentId: scope.agentId,
          conversationId: scope.conversationId,
          purpose: e.purpose,
          provider: e.provider,
          model: e.model,
          inputTokens: e.usage.inputTokens,
          outputTokens: e.usage.outputTokens,
          cachedInputTokens: e.usage.cachedInputTokens ?? 0,
        })),
      ),
    );
  } catch (error) {
    console.error("ai_usage_log: falha ao registrar uso", error instanceof Error ? error.message : "erro");
  }
}

// ---------- copiloto ----------

export async function getCopilotOverview({ deps, actor }: Ctx): Promise<CopilotOverview> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const [settings] = await tx.select().from(schema.copilotSettings).where(eq(schema.copilotSettings.organizationId, actor.organizationId)).limit(1);
    const counts = await tx
      .select({ verdict: schema.copilotFeedback.verdict, n: count() })
      .from(schema.copilotFeedback)
      .where(eq(schema.copilotFeedback.organizationId, actor.organizationId))
      .groupBy(schema.copilotFeedback.verdict);
    const recent = await tx
      .select()
      .from(schema.copilotFeedback)
      .where(and(eq(schema.copilotFeedback.organizationId, actor.organizationId), eq(schema.copilotFeedback.verdict, "bad")))
      .orderBy(desc(schema.copilotFeedback.createdAt))
      .limit(5);
    return {
      enabled: settings?.enabled ?? false,
      teams: settings?.teams ?? [],
      feedback: { useful: counts.find((c) => c.verdict === "useful")?.n ?? 0, bad: counts.find((c) => c.verdict === "bad")?.n ?? 0 },
      recentBad: recent.map((f) => ({ id: f.id, suggestion: f.suggestion, reason: f.reason, at: iso(f.createdAt) })),
    };
  });
}

export async function setCopilotEnabled(ctx: Ctx, enabled: boolean): Promise<Res<CopilotOverview>> {
  const { deps, actor } = ctx;
  const allowed = await withOrg(deps.db, actor.organizationId, async (tx) => checkCopilotAllowed(await planOf(tx, actor)));
  if (!allowed.ok) return err(403, allowed.code, allowed.message);
  await withOrg(deps.db, actor.organizationId, (tx) =>
    tx
      .insert(schema.copilotSettings)
      .values({ id: uuidv7(), organizationId: actor.organizationId, enabled })
      .onConflictDoUpdate({ target: schema.copilotSettings.organizationId, set: { enabled, updatedAt: new Date() } }),
  );
  return ok(await getCopilotOverview(ctx));
}

/** Feedback útil/ruim de uma sugestão do Copiloto (chamado por quem atende; alimenta novos casos de eval, §4.4). */
export async function recordCopilotFeedback({ deps, actor }: Ctx, input: CopilotFeedbackInput): Promise<Res<{ id: string }>> {
  const id = uuidv7();
  await withOrg(deps.db, actor.organizationId, (tx) =>
    tx.insert(schema.copilotFeedback).values({
      id,
      organizationId: actor.organizationId,
      agentId: input.agentId ?? null,
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      verdict: input.verdict,
      suggestion: input.suggestion,
      reason: input.reason ?? null,
      createdBy: actor.userId,
    }),
  );
  return ok({ id });
}
