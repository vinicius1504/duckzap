import type { Channel, ChannelStatus, ChannelType } from "@duckzap/contracts/channels";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import type { ChannelCredentials, ChannelRef } from "../../lib/messaging";
import { webhookUrl } from "./config";
import { webhookSegmentForKind } from "./providers/registry";
import type { ChannelsRuntime } from "./runtime";

export type ChannelRow = typeof schema.channels.$inferSelect;

const credentialsSchema = z.record(z.string(), z.string());

/** UUID com qualquer versão; ids malformados são tratados como "não existe" (404), sem ir ao banco. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findChannel(tx: Transaction, organizationId: string, id: string): Promise<ChannelRow | undefined> {
  if (!UUID_PATTERN.test(id)) return undefined;
  // RLS já filtra por empresa; o filtro explícito é defesa em profundidade
  const [row] = await tx
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.id, id), eq(schema.channels.organizationId, organizationId)))
    .limit(1);
  return row;
}

/**
 * Canal pelo qual uma conversa envia. Com canal: ele. Sem canal (foi apagado): o canal padrão CONECTADO da empresa,
 * ou, na falta dele, o WhatsApp conectado mais antigo; sem nenhum, `undefined` (o envio falha como "sem canal").
 */
export async function findSendChannel(tx: Transaction, organizationId: string, channelId: string | null): Promise<ChannelRow | undefined> {
  if (channelId) return findChannel(tx, organizationId, channelId);
  const rows = await tx
    .select()
    .from(schema.channels)
    .where(and(eq(schema.channels.organizationId, organizationId), eq(schema.channels.status, "connected"), ne(schema.channels.type, "instagram")))
    .orderBy(desc(schema.channels.isDefault), asc(schema.channels.createdAt))
    .limit(1);
  return rows[0];
}

export function readCredentials(row: Pick<ChannelRow, "organizationId" | "credentialsEnc">): ChannelCredentials {
  if (!row.credentialsEnc) return {};
  return credentialsSchema.parse(JSON.parse(decryptSecret(row.organizationId, row.credentialsEnc)));
}

export function sealCredentials(organizationId: string, credentials: ChannelCredentials): string {
  return encryptSecret(organizationId, JSON.stringify(credentials));
}

export function readWebhookToken(row: Pick<ChannelRow, "organizationId" | "webhookTokenEnc">): string {
  return decryptSecret(row.organizationId, row.webhookTokenEnc);
}

export function channelWebhookUrl(row: ChannelRow, runtime: Pick<ChannelsRuntime, "config">): string | undefined {
  const segment = webhookSegmentForKind(row.provider);
  if (!segment) return undefined;
  const base = row.provider === "evolution" ? runtime.config.evolutionWebhookBaseUrl : runtime.config.publicWebhookBaseUrl;
  return webhookUrl(base, segment, readWebhookToken(row));
}

/** Monta a referência que os adaptadores recebem (credenciais já decifradas). */
export function buildRef(row: ChannelRow, runtime: Pick<ChannelsRuntime, "config">, credentials = readCredentials(row)): ChannelRef {
  const url = channelWebhookUrl(row, runtime);
  return {
    id: row.id,
    organizationId: row.organizationId,
    credentials,
    ...(row.address ? { address: row.address } : {}),
    ...(url ? { webhookUrl: url } : {}),
  };
}

/** Linha → contrato do front. Nenhum segredo sai daqui. */
export function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    status: row.status as ChannelStatus,
    address: row.address,
    isDefault: row.isDefault,
    teamId: row.teamId,
    agentId: row.agentId,
    replyMode: row.replyMode,
    signMessages: row.signMessages,
    messages: {
      welcome: row.welcomeMessage,
      outOfHours: row.outOfHoursMessage,
      closing: row.closingMessage,
      rating: row.ratingMessage,
    },
    inactivityTransferMinutes: row.inactivityTransferMinutes as Channel["inactivityTransferMinutes"],
    createdAt: row.createdAt.toISOString(),
    lastStatusChangeAt: row.lastStatusChangeAt.toISOString(),
  };
}

export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
