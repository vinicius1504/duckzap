import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { user } from "./auth";
import { channels } from "./channels";

// Módulo Clientes (CRM). Ids: UUID v7 gerado pela aplicação (não há default no banco). Datas: timestamptz.
// Busca por nome/telefone/e-mail usa pg_trgm (extensão já criada em docker/postgres/init).

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const contacts = pgTable(
  "contacts",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    /** E.164 (+5567998123456). Contato só do Instagram pode não ter. Único por empresa. */
    phone: text(),
    email: text(),
    instagram: text(),
    isCustomer: boolean().notNull().default(false),
    /** customer | service | form | walk_in | event | referral | inbound. Sem origem não recebe convite. */
    origin: text(),
    originNote: text(),
    /** id do usuário responsável (Better Auth `user.id`); se a pessoa for apagada o contato fica sem responsável. */
    ownerId: text().references(() => user.id, { onDelete: "set null" }),
    birthDate: date({ mode: "string" }),
    customFields: jsonb().$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /** Atualizado por Conversas a cada mensagem (ver `touchContactInteraction`). */
    lastInteractionAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    unique("contacts_org_phone_unique").on(t.organizationId, t.phone),
    index("contacts_org_created_idx").on(t.organizationId, t.createdAt),
    index("contacts_org_owner_idx").on(t.organizationId, t.ownerId),
    index("contacts_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("contacts_phone_trgm_idx").using("gin", t.phone.op("gin_trgm_ops")),
    index("contacts_email_trgm_idx").using("gin", t.email.op("gin_trgm_ops")),
    check(
      "contacts_origin_check",
      sql`${t.origin} is null or ${t.origin} in ('customer','service','form','walk_in','event','referral','inbound')`,
    ),
    tenantPolicy("contacts", t.organizationId),
  ],
).enableRLS();

/** Etiquetas. As 4 primeiras por `position` são as etapas do funil (`funnel_stage` 1–4, mantido pelo service). */
export const tags = pgTable(
  "tags",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    description: text().notNull().default(""),
    color: text().notNull(),
    position: integer().notNull(),
    funnelStage: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index("tags_org_position_idx").on(t.organizationId, t.position),
    uniqueIndex("tags_org_name_unique").on(t.organizationId, sql`lower(${t.name})`),
    check("tags_color_check", sql`${t.color} in ('ink','duck','slate','ok','info','warn','err')`),
    check("tags_funnel_stage_check", sql`${t.funnelStage} is null or ${t.funnelStage} between 1 and 4`),
    tenantPolicy("tags", t.organizationId),
  ],
).enableRLS();

export const contactTags = pgTable(
  "contact_tags",
  {
    organizationId: organizationId(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.tagId] }),
    index("contact_tags_org_idx").on(t.organizationId),
    index("contact_tags_tag_idx").on(t.tagId),
    tenantPolicy("contact_tags", t.organizationId),
  ],
).enableRLS();

/** Listas estáticas e segmentos dinâmicos (filtro salvo em `filter`, validado com Zod e avaliado em SQL). */
export const contactLists = pgTable(
  "contact_lists",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    description: text().notNull().default(""),
    kind: text().notNull(),
    filter: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("contact_lists_org_idx").on(t.organizationId),
    uniqueIndex("contact_lists_org_name_unique").on(t.organizationId, sql`lower(${t.name})`),
    check("contact_lists_kind_check", sql`${t.kind} in ('static','segment')`),
    check("contact_lists_segment_filter_check", sql`${t.kind} <> 'segment' or ${t.filter} is not null`),
    tenantPolicy("contact_lists", t.organizationId),
  ],
).enableRLS();

export const contactListMembers = pgTable(
  "contact_list_members",
  {
    organizationId: organizationId(),
    listId: uuid()
      .notNull()
      .references(() => contactLists.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.listId, t.contactId] }),
    index("contact_list_members_org_idx").on(t.organizationId),
    index("contact_list_members_contact_idx").on(t.contactId),
    tenantPolicy("contact_list_members", t.organizationId),
  ],
).enableRLS();

export const contactNotes = pgTable(
  "contact_notes",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Sem FK de propósito: NOT NULL e a nota é histórico; `author_name` guarda o nome de quem escreveu. */
    authorId: text().notNull(),
    authorName: text().notNull(),
    text: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("contact_notes_org_idx").on(t.organizationId),
    index("contact_notes_contact_idx").on(t.contactId, t.createdAt),
    tenantPolicy("contact_notes", t.organizationId),
  ],
).enableRLS();

/** Histórico da ficha (cadastro, etiqueta, importação, consentimento…). */
export const contactEvents = pgTable(
  "contact_events",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    title: text().notNull(),
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("contact_events_org_idx").on(t.organizationId),
    index("contact_events_contact_idx").on(t.contactId, t.createdAt),
    check(
      "contact_events_kind_check",
      sql`${t.kind} in ('conversation','appointment','campaign','consent','tag','import','created')`,
    ),
    tenantPolicy("contact_events", t.organizationId),
  ],
).enableRLS();

/**
 * Consentimento de disparo (opt-in, §5.7 item 7). No máximo UMA linha por contato: é isso que garante
 * "um convite só, para sempre". `pending` com convite enviado há mais de 7 dias vale como `expired`
 * (lido assim mesmo antes do job de expiração rodar).
 */
export const consents = pgTable(
  "consents",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    status: text().notNull(),
    method: text().notNull(),
    /** Texto exato enviado (prova). */
    inviteText: text(),
    inviteQueuedAt: timestamp({ withTimezone: true }),
    /** Dia (fuso da empresa) em que o worker deve enviar. */
    inviteScheduledFor: date({ mode: "string" }),
    /** Preenchido pelo worker quando o provedor aceita a mensagem; inicia o prazo de 7 dias. */
    inviteSentAt: timestamp({ withTimezone: true }),
    /** Resposta do contato (prova). */
    replyText: text(),
    repliedAt: timestamp({ withTimezone: true }),
    /** Canal por onde o convite saiu; apagar o canal solta o vínculo (`channel_name` guarda o nome para a prova). */
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    channelName: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    unique("consents_org_contact_unique").on(t.organizationId, t.contactId),
    index("consents_org_status_idx").on(t.organizationId, t.status),
    index("consents_contact_id_idx").on(t.contactId),
    index("consents_org_channel_queued_idx").on(t.organizationId, t.channelId, t.inviteQueuedAt),
    check("consents_status_check", sql`${t.status} in ('pending','granted','denied','expired')`),
    check("consents_method_check", sql`${t.method} in ('invite','conversation','form')`),
    tenantPolicy("consents", t.organizationId),
  ],
).enableRLS();

/** Arquivo enviado na etapa "prévia" da importação, guardado até a confirmação (stateless entre requests). */
export const contactImports = pgTable(
  "contact_imports",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    fileName: text().notNull(),
    rows: jsonb().$type<Record<string, string>[]>().notNull(),
    createdBy: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("contact_imports_org_idx").on(t.organizationId), tenantPolicy("contact_imports", t.organizationId)],
).enableRLS();
