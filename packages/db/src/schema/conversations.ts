import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { agents } from "./agents";
import { channels } from "./channels";
import { contacts } from "./contacts";
import { teams } from "./team";
import { user } from "./auth";

// Módulos Conversas (inbox, mensagens, IA) e Início (tarefas). Ids: UUID v7 gerado pela aplicação. Datas: timestamptz.
// Apagar um contato (LGPD) apaga em cascata conversas, mensagens e sugestões. As tabelas de auditoria/feedback do módulo
// Agentes guardam o id da conversa como texto (sem FK): o hook de exclusão (modules/conversations/erasure.ts) as limpa.

const now = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/**
 * Uma conversa = um contato num canal. No máximo UMA aberta (não resolvida) por contato+canal
 * (índice parcial): é isso que torna seguro o "acha ou cria" sob mensagens simultâneas.
 * O estado do funil NÃO fica aqui: é a etiqueta-etapa do contato (`contact_tags` + `tags.funnel_stage`).
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * Canal por onde a conversa acontece. Apagar o canal NÃO apaga o histórico: vira null (SET NULL) e a conversa
     * continua salva; a próxima mensagem do contato reaproveita a MESMA conversa e grava o canal novo.
     * Conversa sem canal envia pelo canal padrão conectado da empresa.
     */
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    teamId: uuid().references(() => teams.id, { onDelete: "set null" }),
    /** Pessoa responsável (Better Auth `user.id`). Se a pessoa for apagada a conversa volta para a fila (SET NULL). */
    assigneeId: text().references(() => user.id, { onDelete: "set null" }),
    /** Agente de IA que atende quando o modo permite. */
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** ai_active | handoff_requested | human_active | resolved */
    status: text().notNull().default("human_active"),
    /** ai | copilot | human */
    mode: text().notNull().default("human"),
    /** urgent | high | normal | low */
    priority: text().notNull().default("normal"),
    unreadCount: integer().notNull().default(0),
    /** Desde quando espera uma pessoa (fila). */
    waitingSince: timestamp({ withTimezone: true }),
    /** ai | human */
    resolvedBy: text(),
    resolvedAt: timestamp({ withTimezone: true }),
    // Última mensagem (denormalizada para a lista do inbox não varrer `messages`).
    lastMessageAt: now(),
    lastMessagePreview: text().notNull().default(""),
    lastMessageKind: text().notNull().default("text"),
    lastMessageFileName: text(),
    lastMessageDurationSeconds: integer(),
    /** in | out */
    lastMessageDirection: text().notNull().default("in"),
    lastInboundAt: timestamp({ withTimezone: true }),
    /** Última resposta de pessoa ou agente (mensagens automáticas não contam). */
    lastReplyAt: timestamp({ withTimezone: true }),
    /** Segundos entre a 1ª mensagem do cliente e a 1ª resposta de pessoa/agente (gravado uma vez). */
    firstResponseSeconds: integer(),
    followUpAt: timestamp({ withTimezone: true }),
    followUpPaused: boolean().notNull().default(false),
    /** Rajada (§4.1): a IA responde quando `ai_due_at` vence. Cada mensagem nova empurra o prazo (com teto). */
    aiDueAt: timestamp({ withTimezone: true }),
    aiBurstStartedAt: timestamp({ withTimezone: true }),
    /** Último aviso de "fora do horário" enviado (no máximo um por 12 h). */
    outOfHoursNoticeAt: timestamp({ withTimezone: true }),
    /** API oficial: fim da janela de 24 h para texto livre. */
    windowExpiresAt: timestamp({ withTimezone: true }),
    createdAt: now(),
    updatedAt: now(),
  },
  (t) => [
    index("conversations_org_status_last_idx").on(t.organizationId, t.status, t.lastMessageAt),
    index("conversations_org_assignee_idx").on(t.organizationId, t.assigneeId),
    index("conversations_org_team_idx").on(t.organizationId, t.teamId),
    index("conversations_org_contact_idx").on(t.organizationId, t.contactId),
    // índices que começam na coluna da FK: a cascata ao apagar contato/canal não varre a tabela inteira
    index("conversations_contact_id_idx").on(t.contactId),
    index("conversations_channel_id_idx").on(t.channelId),
    index("conversations_ai_due_idx").on(t.aiDueAt).where(sql`${t.aiDueAt} is not null`),
    uniqueIndex("conversations_one_open_per_contact_channel")
      .on(t.organizationId, t.contactId, t.channelId)
      .where(sql`${t.status} <> 'resolved'`),
    // Com canal: uma aberta por contato+canal (índice acima). Sem canal (canal apagado): uma aberta por contato.
    // (NULL é distinto em índice único, por isso este segundo índice parcial.)
    uniqueIndex("conversations_one_open_per_contact_no_channel")
      .on(t.organizationId, t.contactId)
      .where(sql`${t.status} <> 'resolved' and ${t.channelId} is null`),
    check("conversations_status_check", sql`${t.status} in ('ai_active','handoff_requested','human_active','resolved')`),
    check("conversations_mode_check", sql`${t.mode} in ('ai','copilot','human')`),
    check("conversations_priority_check", sql`${t.priority} in ('urgent','high','normal','low')`),
    check("conversations_resolved_by_check", sql`${t.resolvedBy} is null or ${t.resolvedBy} in ('ai','human')`),
    check("conversations_last_direction_check", sql`${t.lastMessageDirection} in ('in','out')`),
    tenantPolicy("conversations", t.organizationId),
  ],
).enableRLS();

/**
 * Mensagens, notas internas (`kind = 'note'`) e avisos do sistema (`kind = 'event'`).
 * Idempotência: (channel_id, external_id) único — o mesmo evento do provedor nunca vira duas mensagens.
 * Mensagens de saída usam `external_id = out:<id>` / `ai:<conversa>:<gatilho>:<n>` (determinístico) e guardam o id do
 * provedor em `provider_message_id`, que é o que os eventos de status (entregue/lida) trazem.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** Canal da mensagem; null depois que o canal foi apagado (o histórico fica). */
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    /** in | out | internal */
    direction: text().notNull(),
    /** text | audio | image | document | note | event */
    kind: text().notNull(),
    /** sending | sent | delivered | read | failed — só mensagens de saída. */
    status: text(),
    externalId: text(),
    providerMessageId: text(),
    /** Id temporário do navegador (deduplica o envio otimista). */
    clientId: text(),
    body: text().notNull().default(""),
    /** { fileName, mimeType, sizeBytes, durationSeconds, url, mediaRef } */
    media: jsonb().$type<Record<string, unknown>>(),
    /** contact | member | agent | system */
    senderKind: text().notNull(),
    senderId: text(),
    senderName: text().notNull().default(""),
    error: text(),
    errorCode: text(),
    createdAt: now(),
    sentAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    updatedAt: now(),
  },
  (t) => [
    index("messages_org_idx").on(t.organizationId),
    index("messages_conversation_created_idx").on(t.conversationId, t.createdAt),
    index("messages_channel_provider_idx").on(t.channelId, t.providerMessageId),
    index("messages_body_trgm_idx").using("gin", t.body.op("gin_trgm_ops")),
    uniqueIndex("messages_channel_external_key").on(t.channelId, t.externalId),
    uniqueIndex("messages_conversation_client_key").on(t.conversationId, t.clientId),
    check("messages_direction_check", sql`${t.direction} in ('in','out','internal')`),
    check("messages_kind_check", sql`${t.kind} in ('text','audio','image','document','note','event')`),
    check("messages_status_check", sql`${t.status} is null or ${t.status} in ('sending','sent','delivered','read','failed')`),
    check("messages_sender_kind_check", sql`${t.senderKind} in ('contact','member','agent','system')`),
    tenantPolicy("messages", t.organizationId),
  ],
).enableRLS();

/** Sugestão do Copiloto para o compositor (nunca é enviada sozinha). `rating` vem do atendente (útil/ruim). */
export const conversationSuggestions = pgTable(
  "conversation_suggestions",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    body: text().notNull(),
    /** useful | bad */
    rating: text(),
    ratedAt: timestamp({ withTimezone: true }),
    /** null = gerada sozinha pelo modo Copiloto; senão, a pessoa que pediu. */
    createdBy: text(),
    createdAt: now(),
  },
  (t) => [
    index("conversation_suggestions_org_idx").on(t.organizationId),
    index("conversation_suggestions_conversation_idx").on(t.conversationId, t.createdAt),
    check("conversation_suggestions_rating_check", sql`${t.rating} is null or ${t.rating} in ('useful','bad')`),
    tenantPolicy("conversation_suggestions", t.organizationId),
  ],
).enableRLS();

/** Respostas rápidas (`/atalho`) do compositor. */
export const quickReplies = pgTable(
  "quick_replies",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    shortcut: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    createdAt: now(),
  },
  (t) => [
    index("quick_replies_org_idx").on(t.organizationId),
    uniqueIndex("quick_replies_org_shortcut_key").on(t.organizationId, sql`lower(${t.shortcut})`),
    check("quick_replies_shortcut_check", sql`${t.shortcut} ~ '^[a-z0-9_-]+$'`),
    tenantPolicy("quick_replies", t.organizationId),
  ],
).enableRLS();

/**
 * Tarefas: "minhas tarefas" do Início e tarefas do cliente (painel da conversa). Com `contact_id` aparecem no painel
 * do cliente; todas aparecem no Início de quem é responsável (ou de quem vê as métricas da equipe).
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    title: text().notNull(),
    dueAt: timestamp({ withTimezone: true }),
    /** urgent | high | medium | low */
    priority: text().notNull().default("medium"),
    done: boolean().notNull().default(false),
    doneAt: timestamp({ withTimezone: true }),
    /**
     * Pessoa responsável (Better Auth `user.id`). SEM FK de propósito: a coluna é NOT NULL e a tarefa não pode ficar
     * sem dono; o produto desativa pessoas (member_profiles.active) em vez de apagar o usuário.
     */
    assigneeId: text().notNull(),
    contactId: uuid().references(() => contacts.id, { onDelete: "cascade" }),
    createdBy: text().notNull(),
    createdAt: now(),
  },
  (t) => [
    index("tasks_org_assignee_idx").on(t.organizationId, t.assigneeId, t.done),
    index("tasks_org_contact_idx").on(t.organizationId, t.contactId),
    index("tasks_contact_id_idx").on(t.contactId),
    check("tasks_priority_check", sql`${t.priority} in ('urgent','high','medium','low')`),
    tenantPolicy("tasks", t.organizationId),
  ],
).enableRLS();
