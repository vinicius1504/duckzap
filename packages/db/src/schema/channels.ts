import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { agents } from "./agents";
import { teams } from "./team";

/**
 * Canais de atendimento (§1.1 módulo 7, §3.6). Uma linha = um número/conta num provedor.
 * Segredos (token Meta, token da instância Evolution, segredo do webhook) ficam cifrados em
 * `credentials_enc` (AES-256-GCM por empresa, `lib/crypto.ts`) e nunca saem do back.
 */
export const channels = pgTable(
  "channels",
  {
    /** UUID v7 gerado pela API. */
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    /** whatsapp_qr | whatsapp_official | instagram (contrato do front) */
    type: text().notNull(),
    /** Provedor que atende o canal: evolution | meta_cloud | instagram (registry de provedores). */
    provider: text().notNull(),
    /** Status normalizado: connected | qr_pending | awaiting_authorization | disconnected | banned */
    status: text().notNull(),
    /** E.164 (WhatsApp) ou @usuario (Instagram); null enquanto não conectou. */
    address: text(),
    isDefault: boolean().notNull().default(false),
    /**
     * ÚNICA fonte de verdade do vínculo equipe↔canal e agente↔canal (as colunas antigas `teams.channel_ids`,
     * `teams.agent_id` e `agents.channel_ids` foram removidas; as telas derivam essas listas daqui).
     * Apagar a equipe/o agente solta o vínculo (SET NULL).
     */
    teamId: uuid().references(() => teams.id, { onDelete: "set null" }),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /**
     * Como o canal responde: `ai` (só a IA; os textos automáticos abaixo ficam guardados, mas NUNCA são enviados)
     * ou `auto` (mensagens automáticas do sistema, sem IA: conversas novas entram na fila da equipe).
     */
    replyMode: text({ enum: ["ai", "auto"] }).notNull().default("ai"),
    /** Mensagens de PESSOA saem no WhatsApp do cliente com o nome de quem atende (`*Rafael (Vendas):*`). Nunca as da IA. */
    signMessages: boolean().notNull().default(true),
    welcomeMessage: text().notNull().default(""),
    outOfHoursMessage: text().notNull().default(""),
    closingMessage: text().notNull().default(""),
    ratingMessage: text().notNull().default(""),
    /** Sem resposta do cliente por N min → conversa vai para a fila da equipe (10, 30 ou 60). */
    inactivityTransferMinutes: integer().notNull().default(30),
    /** JSON cifrado (`v1:iv:tag:dados`) com as credenciais do provedor. */
    credentialsEnc: text(),
    /** Últimos 4 caracteres do token principal, para a UI ("••••abcd"). */
    credentialsHint: text(),
    /** sha256 (hex) do token secreto da URL do webhook. Só o hash é usado na busca pública. */
    webhookTokenHash: text().notNull(),
    /** O mesmo token, cifrado, para a tela de configuração (Meta) mostrar a URL ao admin. */
    webhookTokenEnc: text().notNull(),
    /** QR atual (cifrado) e quando expira; apagado ao conectar. */
    qrPayloadEnc: text(),
    qrExpiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastStatusChangeAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("channels_organization_id_idx").on(t.organizationId),
    index("channels_team_id_idx").on(t.teamId),
    index("channels_agent_id_idx").on(t.agentId),
    uniqueIndex("channels_webhook_token_hash_key").on(t.webhookTokenHash),
    uniqueIndex("channels_org_name_key").on(t.organizationId, sql`lower(${t.name})`),
    // no máximo um canal padrão por empresa
    uniqueIndex("channels_one_default_per_org").on(t.organizationId).where(sql`${t.isDefault}`),
    check("channels_type_check", sql`${t.type} in ('whatsapp_qr','whatsapp_official','instagram')`),
    check("channels_status_check", sql`${t.status} in ('connected','qr_pending','awaiting_authorization','disconnected','banned')`),
    check("channels_reply_mode_check", sql`${t.replyMode} in ('ai','auto')`),
    check("channels_inactivity_check", sql`${t.inactivityTransferMinutes} in (10,30,60)`),
    tenantPolicy("channels", t.organizationId),
  ],
).enableRLS();

/**
 * Eventos recebidos dos provedores, gravados ANTES de qualquer processamento (§3.3, §5.3).
 * Idempotência: (channel_id, external_id) único. `processed_at` nulo = pendente (reprocessável).
 */
export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Chave de deduplicação: `msg:<id>`, `status:<id>:<status>`, `conn:<status>:<at>` ou `unparsed:<sha256>`. */
    externalId: text().notNull(),
    /** message | status | connection | unparsed */
    kind: text().notNull(),
    /** Corpo cru recebido (já verificado). Pode conter dados pessoais: nunca logar. */
    payload: jsonb().notNull(),
    /** Evento canônico (InboundEvent) extraído do corpo; nulo se o corpo não pôde ser interpretado. */
    event: jsonb(),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    /** Último erro de processamento (sem dados sensíveis). */
    error: text(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("inbound_events_organization_id_idx").on(t.organizationId),
    uniqueIndex("inbound_events_channel_external_key").on(t.channelId, t.externalId),
    index("inbound_events_pending_idx").on(t.receivedAt).where(sql`${t.processedAt} is null`),
    tenantPolicy("inbound_events", t.organizationId),
  ],
).enableRLS();

/**
 * Envios por canal (`sendViaChannel`): idempotência por `external_id` e status do envio.
 * Não guarda destinatário nem texto (o histórico da conversa é do módulo Conversas).
 */
export const channelOutbound = pgTable(
  "channel_outbound",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    externalId: text().notNull(),
    kind: text().notNull(),
    /** sending | sent | failed */
    status: text().notNull(),
    providerMessageId: text(),
    errorCode: text(),
    attempts: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("channel_outbound_organization_id_idx").on(t.organizationId),
    uniqueIndex("channel_outbound_channel_external_key").on(t.channelId, t.externalId),
    check("channel_outbound_status_check", sql`${t.status} in ('sending','sent','failed')`),
    tenantPolicy("channel_outbound", t.organizationId),
  ],
).enableRLS();
