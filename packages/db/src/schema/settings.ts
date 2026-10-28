import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";

// Ids de linha: UUID v7 gerado pela aplicação (o pacote db não depende de `uuid`; veja platform.ts).

/**
 * Ajustes da empresa que não cabem na tabela `organization` do Better Auth (que guarda nome, logo e fuso).
 * Uma linha por empresa; criada no cadastro ou na primeira gravação.
 */
export const organizationSettings = pgTable(
  "organization_settings",
  {
    organizationId: organizationId().primaryKey(),
    segment: text().notNull().default(""),
    phone: text().notNull().default(""),
    email: text().notNull().default(""),
    /** Horário comercial da empresa (BusinessHours do contrato de Ajustes: 7 dias, 0 = domingo). */
    businessHours: jsonb().notNull(),
    /** Mensagem de boas-vindas escolhida no cadastro. */
    welcomeMessage: text().notNull().default(""),
    /** ServiceSettings.followUp */
    followUp: jsonb().notNull(),
    /** ServiceSettings.inactivityClose */
    inactivityClose: jsonb().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [tenantPolicy("organization_settings", t.organizationId)],
).enableRLS();

/** Estado das integrações (Google Agenda, Instagram, WhatsApp oficial). OAuth real fica para depois. */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    /** 'google_calendar' | 'instagram' | 'whatsapp_official' */
    provider: text().notNull(),
    /** 'connected' | 'awaiting_authorization' | 'disconnected' | 'error' */
    status: text().notNull().default("disconnected"),
    displayName: text(),
    lastSyncAt: timestamp({ withTimezone: true }),
    /** Token cifrado com `encryptSecret` (§5.2). Nunca volta para a UI. */
    secretEncrypted: text(),
    secretLast4: text(),
    phoneNumberIdLast4: text(),
    /** Token de verificação do webhook de entrada (não dá acesso a nada). */
    verifyToken: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("integrations_org_provider_unique").on(t.organizationId, t.provider),
    index("integrations_organization_id_idx").on(t.organizationId),
    tenantPolicy("integrations", t.organizationId),
  ],
).enableRLS();

/**
 * Chaves de API do cliente. Só o hash (SHA-256) é guardado. O segredo tem o formato
 * `dz_live_<organizationId>.<aleatório>`: o id da empresa no segredo permite achar o tenant
 * antes de consultar a tabela (que tem RLS) sem expor outra empresa.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    prefix: text().notNull().default("dz_live_"),
    last4: text().notNull(),
    keyHash: text().notNull().unique(),
    scopes: text().array().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index("api_keys_organization_id_idx").on(t.organizationId), tenantPolicy("api_keys", t.organizationId)],
).enableRLS();

/** Webhooks de saída. O segredo de assinatura fica cifrado; só os últimos 4 voltam para a UI. */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    url: text().notNull(),
    events: text().array().notNull(),
    active: boolean().notNull().default(true),
    secretEncrypted: text().notNull(),
    secretLast4: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastDeliveryAt: timestamp({ withTimezone: true }),
    lastDeliveryStatus: integer(),
    lastDeliveryOk: boolean(),
  },
  (t) => [
    unique("webhook_endpoints_org_url_unique").on(t.organizationId, t.url),
    index("webhook_endpoints_organization_id_idx").on(t.organizationId),
    tenantPolicy("webhook_endpoints", t.organizationId),
  ],
).enableRLS();
