import { effectiveSubscriptionStatus, isSendingPausedStatus, type SubscriptionStatus } from "@duckzap/contracts/session";
import { schema, type Transaction } from "@duckzap/db";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { outboundMessageSchema, type MessagingProvider, type OutboundMessage, type SendResult } from "../../lib/messaging";
import { buildRef, findChannel } from "./repo";
import { getChannelsRuntime, type ChannelsRuntime } from "./runtime";
import { isSafeMediaUrlResolved } from "./security";

/**
 * Mesma regra de `buildSession` e do Painel Admin (`effectiveSubscriptionStatus`): tolerância de 1 dia depois do vencimento;
 * depois disso (ou teste vencido, empresa desativada, cancelada) o envio fica pausado.
 */
export async function isSendingPausedForOrg(tx: Transaction, now: Date): Promise<boolean> {
  const [subscription] = await tx.select().from(schema.subscriptions).limit(1);
  if (!subscription) return true;
  return isSendingPausedStatus(
    effectiveSubscriptionStatus({
      status: subscription.status as SubscriptionStatus,
      currentPeriodEnd: subscription.currentPeriodEnd,
      disabledAt: subscription.disabledAt,
      now,
    }),
  );
}

async function validateMessage(message: OutboundMessage): Promise<string | null> {
  switch (message.kind) {
    case "text":
      return message.text?.trim() ? null : "Mensagem de texto vazia.";
    case "template":
      return message.template ? null : "Modelo de mensagem ausente.";
    default:
      // por base64 não há endereço a conferir; por URL, ela precisa ser https e pública (anti-SSRF)
      if (!message.mediaUrl && !message.mediaBase64) return "Mídia sem arquivo.";
      if (message.mediaUrl && !(await isSafeMediaUrlResolved(message.mediaUrl))) return "O endereço do arquivo precisa ser https e público.";
      return null;
  }
}

/** `typingMs` só chega a provedor com a capacidade `presence` (e `PRESENCE_ENABLED` ligado, que a desliga no adaptador). */
export function withoutUnsupportedTyping(provider: Pick<MessagingProvider, "capabilities">, message: OutboundMessage): OutboundMessage {
  if (message.typingMs === undefined || provider.capabilities().presence) return message;
  const { typingMs: _ignored, ...rest } = message;
  return rest;
}

export type SendDeps = Pick<ChannelsRuntime, "providers" | "sendLimiterFor" | "now" | "log" | "config">;

/**
 * Envia uma mensagem por um canal (Conversas e Campanhas usam isto; §3.6).
 *  - roda dentro da transação do chamador (`withOrg`): o canal é lido sob RLS, então canal de outra empresa = "não existe";
 *  - plano expirado bloqueia no servidor;
 *  - idempotente por `message.externalId` (por canal): repetir devolve o resultado anterior sem reenviar;
 *  - rate limit por canal (balde de fichas em memória; `RateLimiter` aceita Redis);
 *  - grava o status em `channel_outbound`.
 * Observação: a chamada HTTP ao provedor acontece dentro da transação do chamador; com fila (BullMQ) o worker
 * abre a transação só em volta desta função, então o tempo de conexão ocupada é o de um envio.
 */
export async function sendViaChannel(
  tx: Transaction,
  channelId: string,
  rawMessage: OutboundMessage,
  deps: SendDeps = getChannelsRuntime(),
): Promise<SendResult> {
  const parsed = outboundMessageSchema.safeParse(rawMessage);
  if (!parsed.success) return { ok: false, code: "rejected", message: "Mensagem inválida." };
  const message = parsed.data;
  const problem = await validateMessage(message);
  if (problem) return { ok: false, code: "rejected", message: problem };

  // a empresa vem do tenant fixado pela transação (`withOrg`), nunca do chamador
  const [tenant] = await tx.execute<{ org: string | null }>(sql`select nullif(current_setting('app.org_id', true), '') as org`);
  const organizationId = tenant?.org;
  if (!organizationId) return { ok: false, code: "rejected", message: "Empresa não definida na transação." };

  const row = await findChannel(tx, organizationId, channelId);
  if (!row) return { ok: false, code: "rejected", message: "Canal não encontrado." };
  if (await isSendingPausedForOrg(tx, deps.now())) {
    return { ok: false, code: "plan_paused", message: "Seu plano expirou: o envio de mensagens está pausado." };
  }
  if (row.status !== "connected") return { ok: false, code: "disconnected", message: "O canal está desconectado." };
  const provider = deps.providers.get(row.provider);
  if (!provider) return { ok: false, code: "unknown", message: "Provedor indisponível." };

  // idempotência: reserva (canal, externalId); quem chegar depois vê o que já aconteceu
  const claimed = await tx
    .insert(schema.channelOutbound)
    .values({ id: uuidv7(), organizationId, channelId: row.id, externalId: message.externalId, kind: message.kind, status: "sending" })
    .onConflictDoNothing()
    .returning({ id: schema.channelOutbound.id });
  let recordId = claimed[0]?.id;
  if (!recordId) {
    const [existing] = await tx
      .select()
      .from(schema.channelOutbound)
      .where(and(eq(schema.channelOutbound.channelId, row.id), eq(schema.channelOutbound.externalId, message.externalId)))
      .limit(1);
    if (!existing) return { ok: false, code: "unknown", message: "Não foi possível registrar o envio." };
    if (existing.status === "sent" && existing.providerMessageId) return { ok: true, providerMessageId: existing.providerMessageId };
    if (existing.status === "sending") return { ok: false, code: "unknown", message: "Este envio já está em andamento." };
    // falhou antes: permite nova tentativa com o mesmo id
    await tx
      .update(schema.channelOutbound)
      .set({ status: "sending", errorCode: null, attempts: sql`${schema.channelOutbound.attempts} + 1`, updatedAt: sql`now()` })
      .where(eq(schema.channelOutbound.id, existing.id));
    recordId = existing.id;
  }

  const limit = await deps.sendLimiterFor(row.provider).take(row.id);
  if (!limit.allowed) {
    // não consumiu o provedor: libera a reserva para o chamador tentar de novo depois
    await tx.delete(schema.channelOutbound).where(eq(schema.channelOutbound.id, recordId));
    return { ok: false, code: "rate_limited", message: `Muitas mensagens neste canal. Tente de novo em ${Math.ceil(limit.retryAfterMs / 1000)} s.` };
  }

  let result: SendResult;
  try {
    result = await provider.send(buildRef(row, deps), withoutUnsupportedTyping(provider, message));
  } catch (error) {
    deps.log.error("channels.send.provider_error", { channelId: row.id, error: error instanceof Error ? error.name : "unknown" });
    result = { ok: false, code: "unknown", message: "Falha ao enviar. Tente de novo." };
  }

  await tx
    .update(schema.channelOutbound)
    .set(
      result.ok
        ? { status: "sent", providerMessageId: result.providerMessageId, updatedAt: sql`now()` }
        : { status: "failed", errorCode: result.code, updatedAt: sql`now()` },
    )
    .where(eq(schema.channelOutbound.id, recordId));
  if (!result.ok && result.code === "disconnected") {
    await tx.update(schema.channels).set({ status: "disconnected", lastStatusChangeAt: sql`now()`, updatedAt: sql`now()` }).where(eq(schema.channels.id, row.id));
  }
  return result;
}
