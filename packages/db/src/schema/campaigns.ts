import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { channels } from "./channels";
import { contactLists, contacts } from "./contacts";

// Módulo Campanhas (§1.1 módulo 5, §5.7). Ids: UUID v7 gerado pela aplicação. Datas: timestamptz.
// O motor de envio seguro (apps/api/src/modules/campaigns/engine) lê/escreve estas tabelas dentro de `withOrg`.

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/** Modelos de mensagem: internos (texto livre) e da Meta (API oficial, com status de aprovação; só leitura na UI). */
export const campaignTemplates = pgTable(
  "campaign_templates",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    /** text | text_image | buttons | list */
    type: text().notNull(),
    body: text().notNull(),
    buttons: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** internal | meta */
    source: text().notNull().default("internal"),
    /** approved | pending | rejected (só source = meta) */
    metaStatus: text(),
    /** Nome do modelo no WhatsApp Manager e idioma (só source = meta). */
    metaName: text(),
    metaLanguage: text(),
    /** Variáveis que preenchem {{1}}, {{2}}… do corpo, na ordem (ex.: ["{nome}"]). */
    metaParams: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    index("campaign_templates_org_idx").on(t.organizationId, t.updatedAt),
    check("campaign_templates_type_check", sql`${t.type} in ('text','text_image','buttons','list')`),
    check("campaign_templates_source_check", sql`${t.source} in ('internal','meta')`),
    check("campaign_templates_meta_status_check", sql`${t.metaStatus} is null or ${t.metaStatus} in ('approved','pending','rejected')`),
    check("campaign_templates_meta_check", sql`${t.source} = 'internal' or ${t.metaStatus} is not null`),
    tenantPolicy("campaign_templates", t.organizationId),
  ],
).enableRLS();

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    /** draft | scheduled | sending | paused | completed | canceled */
    status: text().notNull().default("draft"),

    /** Lista/segmento de Clientes; o público é um SNAPSHOT (campaign_recipients) congelado no disparo. */
    audienceId: uuid().references(() => contactLists.id, { onDelete: "set null" }),
    audienceName: text(),
    /** Contagens do público no momento do disparo (total, optedIn, notOptedIn, optedOut, duplicates, noWhatsapp). */
    audienceSnapshot: jsonb().$type<Record<string, number>>(),

    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    channelName: text(),
    /** whatsapp_qr | whatsapp_official (cópia na criação do envio; o histórico sobrevive à exclusão do canal) */
    channelKind: text(),

    // mensagem
    messageType: text().notNull(),
    body: text().notNull().default(""),
    imageName: text(),
    buttons: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    listButtonLabel: text().notNull().default(""),
    listItems: jsonb().$type<{ title: string; description: string }[]>().notNull().default(sql`'[]'::jsonb`),
    optOutLine: text().notNull(),
    officialTemplateId: uuid().references(() => campaignTemplates.id, { onDelete: "set null" }),
    /** bank | per_message */
    variationMode: text().notNull().default("bank"),
    /** Mensagem base que gerou o banco (se a base mudar, o banco precisa ser gerado de novo). */
    variationsBase: text(),

    // envio
    scheduleMode: text().notNull().default("now"),
    scheduledAt: timestamp({ withTimezone: true }),
    intervalMinSeconds: integer().notNull().default(45),
    intervalMaxSeconds: integer().notNull().default(120),
    windowStart: text().notNull().default("08:00"),
    windowEnd: text().notNull().default("20:00"),
    skipSundaysAndHolidays: boolean().notNull().default(true),

    // estado do motor
    pauseReason: text(),
    pauseDetail: text(),
    nextSendAt: timestamp({ withTimezone: true }),
    /** Estado do sorteador de intervalos e da seleção de variação (último intervalo, mensagens desde a pausa longa…). */
    engineState: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    recipientsTotal: integer().notNull().default(0),

    createdBy: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("campaigns_org_status_idx").on(t.organizationId, t.status),
    index("campaigns_org_updated_idx").on(t.organizationId, t.updatedAt),
    index("campaigns_due_idx").on(t.status, t.nextSendAt),
    index("campaigns_channel_idx").on(t.channelId),
    check("campaigns_status_check", sql`${t.status} in ('draft','scheduled','sending','paused','completed','canceled')`),
    check("campaigns_message_type_check", sql`${t.messageType} in ('text','text_image','buttons','list')`),
    check("campaigns_variation_mode_check", sql`${t.variationMode} in ('bank','per_message')`),
    check("campaigns_schedule_mode_check", sql`${t.scheduleMode} in ('now','scheduled')`),
    check("campaigns_channel_kind_check", sql`${t.channelKind} is null or ${t.channelKind} in ('whatsapp_qr','whatsapp_official')`),
    // piso de 30 s do §5.7 item 3 também no banco
    check("campaigns_interval_check", sql`${t.intervalMinSeconds} >= 30 and ${t.intervalMaxSeconds} > ${t.intervalMinSeconds}`),
    check(
      "campaigns_pause_reason_check",
      sql`${t.pauseReason} is null or ${t.pauseReason} in ('manual','channel_disconnected','high_failure_rate','opt_outs','provider_restriction','outside_window','subscription_expired')`,
    ),
    tenantPolicy("campaigns", t.organizationId),
  ],
).enableRLS();

/** Banco de variações (QR). Só `approved` entra no sorteio; o texto inclui a linha de saída. */
export const campaignVariations = pgTable(
  "campaign_variations",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    text: text().notNull(),
    /** pending | approved | rejected */
    review: text().notNull().default("pending"),
    /** Alterada à mão pelo usuário depois de gerada. */
    edited: boolean().notNull().default(false),
    /** Problemas apontados pelo validador (código, §5.7 item 4), recalculados no servidor a cada gravação. */
    issues: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("campaign_variations_org_idx").on(t.organizationId),
    index("campaign_variations_campaign_idx").on(t.campaignId, t.position),
    check("campaign_variations_review_check", sql`${t.review} in ('pending','approved','rejected')`),
    tenantPolicy("campaign_variations", t.organizationId),
  ],
).enableRLS();

/**
 * Um envio por contato (§5.7 item 6). Criado no disparo (snapshot do público, já embaralhado em `position`).
 * `rendered_text` guarda o texto EXATO enviado. Apagar o contato (LGPD) apaga a linha em cascata.
 */
export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Ordem de envio (embaralhada, quem conversou nos últimos 90 dias primeiro). */
    position: integer().notNull(),
    /** queued | sent | delivered | read | replied | failed | opted_out | no_whatsapp | skipped */
    status: text().notNull().default("queued"),
    reason: text(),
    renderedText: text(),
    variationId: uuid().references(() => campaignVariations.id, { onDelete: "set null" }),
    variationNumber: integer(),
    /** Intervalo sorteado depois deste envio (até o próximo). */
    intervalSeconds: integer(),
    /** Pausa longa aplicada depois deste envio, quando houve. */
    longPauseSeconds: integer(),
    /** Dia de envio da campanha (1 = primeiro dia). */
    dayIndex: integer(),
    /** Chave de idempotência enviada ao provedor: determinística por destinatário. */
    externalId: text().notNull(),
    providerMessageId: text(),
    errorCode: text(),
    /** Reservado pelo motor antes de chamar o provedor (nulo = ainda não tentado). */
    attemptedAt: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    repliedAt: timestamp({ withTimezone: true }),
    optedOutAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    unique("campaign_recipients_campaign_contact_unique").on(t.campaignId, t.contactId),
    uniqueIndex("campaign_recipients_external_id_key").on(t.organizationId, t.externalId),
    index("campaign_recipients_org_idx").on(t.organizationId),
    index("campaign_recipients_queue_idx").on(t.campaignId, t.status, t.position),
    index("campaign_recipients_contact_idx").on(t.contactId, t.sentAt),
    index("campaign_recipients_provider_msg_idx").on(t.providerMessageId),
    index("campaign_recipients_attempted_idx").on(t.campaignId, t.attemptedAt),
    check(
      "campaign_recipients_status_check",
      sql`${t.status} in ('queued','sent','delivered','read','replied','failed','opted_out','no_whatsapp','skipped')`,
    ),
    tenantPolicy("campaign_recipients", t.organizationId),
  ],
).enableRLS();

/** Aceite dos termos de campanhas (antes do primeiro disparo). Um por versão dos termos e empresa. */
export const campaignTermsAcceptance = pgTable(
  "campaign_terms_acceptance",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    /** Sem FK de propósito: NOT NULL e prova de aceite (o aceite não some se a pessoa for apagada; `user_name` fica). */
    userId: text().notNull(),
    userName: text().notNull(),
    version: text().notNull(),
    acceptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("campaign_terms_org_version_unique").on(t.organizationId, t.version),
    index("campaign_terms_org_idx").on(t.organizationId),
    tenantPolicy("campaign_terms_acceptance", t.organizationId),
  ],
).enableRLS();
