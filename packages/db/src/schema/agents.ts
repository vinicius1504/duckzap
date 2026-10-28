import { sql } from "drizzle-orm";
import { boolean, check, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, vector } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { messages } from "./conversations";

// Módulo Agentes de IA (§1.1 módulo 6, §4). Toda tabela é de tenant (RLS por organization_id).
// SQL que o Drizzle não expressa (extensões pg_trgm/vector): ver `agents.sql.md` ANTES de gerar a migration.

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const now = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** Um agente = um trabalho (atendimento, follow-up, agendamento…). A configuração vive em `agent_versions`. */
export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    job: text().notNull(),
    status: text().notNull().default("inactive"),
    isDefault: boolean().notNull().default(false),
    /** nomes/ids de equipes (texto simples; FK adicionada na integração com Equipe) */
    teams: text().array().notNull().default(sql`'{}'::text[]`),
    // Os canais do agente são os que têm `channels.agent_id` = este agente (fonte de verdade em `channels`).
    pausedReason: text(),
    /** PONTEIRO para a versão ativa (`agent_versions.number`). Rollback = mover o ponteiro. */
    currentVersion: integer().notNull().default(1),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    index("agents_organization_id_idx").on(t.organizationId),
    check("agents_job_check", sql`${t.job} in ('support','follow_up','scheduling','instagram_dm','comments')`),
    check("agents_status_check", sql`${t.status} in ('active','paused','inactive')`),
    tenantPolicy("agents", t.organizationId),
  ],
).enableRLS();

/** Toda alteração cria uma versão nova (imutável). `config` é validado com `agentConfigSchema` (Zod) antes de gravar. */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    config: jsonb().notNull(),
    summary: text().notNull(),
    createdBy: text().notNull(),
    createdAt: now(),
  },
  (t) => [
    index("agent_versions_organization_id_idx").on(t.organizationId),
    unique("agent_versions_agent_number_key").on(t.agentId, t.number),
    tenantPolicy("agent_versions", t.organizationId),
  ],
).enableRLS();

/** Documentos de conhecimento. Hoje só TXT tem texto extraído; PDF/DOCX ficam `processing`/`failed` até haver extrator. */
export const agentDocuments = pgTable(
  "agent_documents",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text().notNull(),
    kind: text().notNull(),
    sizeBytes: integer().notNull(),
    pages: integer(),
    status: text().notNull().default("processing"),
    error: text(),
    extractedText: text(),
    createdBy: text().notNull(),
    uploadedAt: now(),
  },
  (t) => [
    index("agent_documents_organization_id_idx").on(t.organizationId),
    index("agent_documents_agent_id_idx").on(t.agentId),
    check("agent_documents_kind_check", sql`${t.kind} in ('pdf','docx','txt')`),
    check("agent_documents_status_check", sql`${t.status} in ('processing','ready','failed')`),
    tenantPolicy("agent_documents", t.organizationId),
  ],
).enableRLS();

/**
 * Trechos do conhecimento. Busca hoje: full-text (`search_vector`, config 'portuguese') + trigram (`content`).
 * `embedding` é OPCIONAL (Anthropic não oferece embeddings): fica nulo até existir um `EmbeddingProvider`.
 */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    documentId: uuid().references(() => agentDocuments.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
    content: text().notNull(),
    searchVector: tsvector().generatedAlwaysAs(sql`to_tsvector('portuguese', content)`),
    embedding: vector({ dimensions: 1536 }),
    createdAt: now(),
  },
  (t) => [
    index("knowledge_chunks_organization_id_idx").on(t.organizationId),
    index("knowledge_chunks_agent_id_idx").on(t.agentId),
    index("knowledge_chunks_search_vector_idx").using("gin", t.searchVector),
    index("knowledge_chunks_content_trgm_idx").using("gin", t.content.op("gin_trgm_ops")),
    index("knowledge_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    tenantPolicy("knowledge_chunks", t.organizationId),
  ],
).enableRLS();

/** Configuração do Copiloto por empresa (liga/desliga e equipes). Só Escala (feature `copilot`). */
export const copilotSettings = pgTable(
  "copilot_settings",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId().unique(),
    enabled: boolean().notNull().default(false),
    teams: text().array().notNull().default(sql`'{}'::text[]`),
    updatedAt: now(),
  },
  (t) => [index("copilot_settings_organization_id_idx").on(t.organizationId), tenantPolicy("copilot_settings", t.organizationId)],
).enableRLS();

/** Feedback do atendente sobre sugestões do Copiloto (alimenta novos casos de eval, §4.4). */
export const copilotFeedback = pgTable(
  "copilot_feedback",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    /** Apagar o agente/mensagem solta o vínculo; o feedback fica (alimenta os evals). */
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** Texto sem FK de propósito: o gancho de exclusão de contato (conversations/erasure.ts) apaga estas linhas (LGPD). */
    conversationId: text().notNull(),
    messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    verdict: text().notNull(),
    suggestion: text().notNull(),
    reason: text(),
    createdBy: text().notNull(),
    createdAt: now(),
  },
  (t) => [
    index("copilot_feedback_organization_id_idx").on(t.organizationId, t.createdAt),
    check("copilot_feedback_verdict_check", sql`${t.verdict} in ('useful','bad')`),
    tenantPolicy("copilot_feedback", t.organizationId),
  ],
).enableRLS();

/** Uso de tokens por empresa/conversa/finalidade: base do orçamento mensal e dos custos (§4.3). Sem conteúdo de mensagens. */
export const aiUsageLog = pgTable(
  "ai_usage_log",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    /** Log de consumo: o agente apagado vira null, o consumo continua contando no orçamento da empresa. */
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** Texto sem FK de propósito (log; o gancho de exclusão de contato o apaga, LGPD). */
    conversationId: text(),
    purpose: text().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cachedInputTokens: integer().notNull().default(0),
    createdAt: now(),
  },
  (t) => [
    index("ai_usage_log_organization_id_idx").on(t.organizationId, t.createdAt),
    index("ai_usage_log_conversation_idx").on(t.organizationId, t.conversationId),
    tenantPolicy("ai_usage_log", t.organizationId),
  ],
).enableRLS();

/** Auditoria das transições da máquina de estados da conversa (§4.1). Conversas grava; Agentes lê para as métricas. */
export const conversationAiEvents = pgTable(
  "conversation_ai_events",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    /** Texto sem FK de propósito (auditoria; o gancho de exclusão de contato o apaga, LGPD). */
    conversationId: text().notNull(),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    fromState: text().notNull(),
    toState: text().notNull(),
    event: text().notNull(),
    actor: text().notNull(),
    reason: text(),
    userId: text(),
    createdAt: now(),
  },
  (t) => [
    index("conversation_ai_events_organization_id_idx").on(t.organizationId, t.createdAt),
    index("conversation_ai_events_conversation_idx").on(t.organizationId, t.conversationId),
    tenantPolicy("conversation_ai_events", t.organizationId),
  ],
).enableRLS();
