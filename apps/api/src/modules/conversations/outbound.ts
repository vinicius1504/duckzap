import type { Transaction } from "@duckzap/db";
import { schema } from "@duckzap/db";
import { and, eq, sql } from "drizzle-orm";
import type { OutboundMessage, SendResult } from "../../lib/messaging";
import { sendViaChannel, type SendDeps } from "../channels/sending";
import { getChannelsRuntime } from "../channels/runtime";
import { findSendChannel } from "../channels/repo";
import { queueRealtime } from "../../lib/realtime";
import { newId } from "../contacts/result";
import { MEDIA_UNAVAILABLE } from "../media/logic";
import { buildMediaMessage } from "../media/outbound";
import { lastMessageKindOf, previewOf } from "./logic";
import type { ConversationRow, MessageRow } from "./queries";
import { signMessage } from "./signature";

const { conversations, messages, conversationAiEvents } = schema;

export type Sender = { kind: "member" | "agent" | "system"; id: string | null; name: string };
/** `url` fica sempre null aqui: a URL de leitura é assinada na hora da leitura. O arquivo é achado por `mediaId` (tabela `media_files`). */
export type Media = { fileName: string | null; mimeType: string; sizeBytes: number | null; durationSeconds: number | null; url: string | null; mediaId?: string | null };

export { MEDIA_UNAVAILABLE };

export const NO_CHANNEL = "Sem canal conectado. Conecte um canal em Canais e reenvie a mensagem.";

export function failureText(result: Extract<SendResult, { ok: false }>, channelName: string): { text: string; reconnect: boolean } {
  switch (result.code) {
    case "disconnected":
      return { text: `O canal ${channelName} está desconectado. Reconecte em Canais e tente de novo.`, reconnect: true };
    case "plan_paused":
      return { text: "Seu plano expirou: o envio de mensagens está pausado até renovar.", reconnect: false };
    default:
      return { text: result.message, reconnect: false };
  }
}

/** Mensagem de sistema na linha do tempo ("Marina assumiu a conversa"). Não mexe em última mensagem nem em não lidas. */
export async function addEvent(tx: Transaction, conv: Pick<ConversationRow, "id" | "organizationId" | "channelId">, body: string, now = new Date()) {
  await tx.insert(messages).values({
    id: newId(),
    organizationId: conv.organizationId,
    conversationId: conv.id,
    channelId: conv.channelId,
    direction: "internal",
    kind: "event",
    body,
    senderKind: "system",
    senderName: "Duckzap",
    createdAt: now,
    updatedAt: now,
  });
  queueRealtime(tx, conv.organizationId, { type: "conversation.message", conversationId: conv.id, direction: "internal" });
}

export async function addNote(tx: Transaction, conv: Pick<ConversationRow, "id" | "organizationId" | "channelId">, sender: Sender, body: string, clientId: string | null, now = new Date()): Promise<MessageRow> {
  const [row] = await tx
    .insert(messages)
    .values({
      id: newId(),
      organizationId: conv.organizationId,
      conversationId: conv.id,
      channelId: conv.channelId,
      direction: "internal",
      kind: "note",
      body,
      clientId,
      senderKind: sender.kind,
      senderId: sender.id,
      senderName: sender.name,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("nota não gravada");
  queueRealtime(tx, conv.organizationId, { type: "conversation.message", conversationId: conv.id, direction: "internal" });
  return row;
}

/** Auditoria das transições do orquestrador (§4.1): quem, de onde, para onde, por quê. */
export async function auditState(
  tx: Transaction,
  conv: Pick<ConversationRow, "id" | "organizationId" | "agentId">,
  t: { from: string; to: string; event: string; actor: "customer" | "ai" | "human" | "system"; reason?: string | null; userId?: string | null },
) {
  await tx.insert(conversationAiEvents).values({
    id: newId(),
    organizationId: conv.organizationId,
    conversationId: conv.id,
    agentId: conv.agentId,
    fromState: t.from,
    toState: t.to,
    event: t.event,
    actor: t.actor,
    reason: t.reason ?? null,
    userId: t.userId ?? null,
  });
}

export type DeliverInput = {
  conv: ConversationRow;
  channelName: string;
  /** Telefone E.164 (ou @usuario); null = contato sem endereço. */
  to: string | null;
  kind: "text" | "audio" | "image" | "document";
  body: string;
  media: Media | null;
  sender: Sender;
  /** Chave de idempotência por canal. Repetir devolve a mensagem que já existe. */
  externalId: string;
  clientId?: string | null;
  /** Mensagem de pessoa/agente (conta como resposta); avisos automáticos não contam. */
  countsAsReply: boolean;
  /** Reaproveita a linha (reenvio). */
  existing?: MessageRow;
  now?: Date;
  sendDeps?: SendDeps;
  /** "Digitando…" ao contato por este tempo antes de entregar (só texto; provedor sem `presence` ignora em `sendViaChannel`). */
  typingMs?: number;
};

export type DeliverResult = { message: MessageRow; ok: boolean; reconnect: boolean; reason: string | null };

function textOutbound(input: DeliverInput, to: string): OutboundMessage {
  return { externalId: input.externalId, to, kind: "text", text: input.body, ...(input.typingMs ? { typingMs: input.typingMs } : {}) };
}

/**
 * Grava a mensagem de saída e envia pelo canal (`sendViaChannel`: plano, idempotência, limite por canal). Roda na transação
 * do chamador. Falha de envio NÃO derruba a transação: a mensagem fica `failed` com o motivo, para a tela oferecer reenvio.
 */
export async function deliverOutbound(tx: Transaction, input: DeliverInput): Promise<DeliverResult> {
  const now = input.now ?? new Date();
  const { conv } = input;
  // conversa sem canal (o canal foi apagado): envia pelo canal padrão conectado; sem nenhum, a mensagem falha com motivo claro
  const sendChannel = await findSendChannel(tx, conv.organizationId, conv.channelId);
  const messageChannelId = sendChannel?.id ?? conv.channelId;

  let row = input.existing;
  if (!row) {
    const inserted = await tx
      .insert(messages)
      .values({
        id: newId(),
        organizationId: conv.organizationId,
        conversationId: conv.id,
        channelId: messageChannelId,
        direction: "out",
        kind: input.kind,
        status: "sending",
        externalId: input.externalId,
        clientId: input.clientId ?? null,
        body: input.body,
        media: input.media,
        senderKind: input.sender.kind,
        senderId: input.sender.id,
        senderName: input.sender.name,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    row = inserted[0];
    if (!row) {
      // já existe (mesmo canal+externalId ou mesmo clientId): devolve o que está gravado, sem reenviar
      const [existing] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.externalId, input.externalId)))
        .limit(1);
      const [byClient] = !existing && input.clientId
        ? await tx.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId))).limit(1)
        : [];
      const found = existing ?? byClient;
      if (!found) throw new Error("mensagem de saída não gravada");
      return { message: found, ok: found.status !== "failed", reconnect: false, reason: found.error };
    }
  }

  // texto como o cliente recebe: com o nome de quem atende (canal com assinatura ligada, só WhatsApp, só mensagem de pessoa)
  let outboundInput = input;
  if (input.sender.kind === "member" && sendChannel?.signMessages && sendChannel.type !== "instagram" && input.body.trim()) {
    const teamName = conv.teamId
      ? (await tx.select({ name: schema.teams.name }).from(schema.teams).where(eq(schema.teams.id, conv.teamId)).limit(1))[0]?.name ?? null
      : null;
    outboundInput = { ...input, body: signMessage(input.body, input.sender.name, teamName) };
  }
  let result: SendResult;
  if (!sendChannel) result = { ok: false, code: "disconnected", message: NO_CHANNEL };
  else if (!input.to) result = { ok: false, code: "rejected", message: "Este contato não tem número para receber a mensagem." };
  else {
    const deps = input.sendDeps ?? getChannelsRuntime();
    // texto direto; mídia: o arquivo vem do armazenamento pelo `mediaId` (URL assinada ou base64), nunca de uma URL do cliente
    const outbound =
      outboundInput.kind === "text"
        ? ({ ok: true, message: textOutbound(outboundInput, input.to) } as const)
        : await buildMediaMessage(
            tx,
            { organizationId: conv.organizationId, kind: outboundInput.kind, mediaId: outboundInput.media?.mediaId, to: input.to, externalId: outboundInput.externalId, caption: outboundInput.body },
            deps.providers.get(sendChannel.provider),
          );
    result = outbound.ok ? await sendViaChannel(tx, sendChannel.id, outbound.message, deps) : { ok: false, code: "rejected", message: outbound.message };
  }

  let updated: MessageRow;
  let reconnect = false;
  let reason: string | null = null;
  if (result.ok) {
    [updated] = await tx
      .update(messages)
      .set({ status: "sent", providerMessageId: result.providerMessageId, error: null, errorCode: null, sentAt: now, updatedAt: now })
      .where(eq(messages.id, row.id))
      .returning() as [MessageRow];
  } else {
    const failure = !sendChannel ? { text: NO_CHANNEL, reconnect: true } : failureText(result, input.channelName);
    reconnect = failure.reconnect;
    reason = failure.text;
    [updated] = await tx
      .update(messages)
      .set({ status: "failed", error: failure.text, errorCode: result.code, updatedAt: now })
      .where(eq(messages.id, row.id))
      .returning() as [MessageRow];
  }

  if (!input.existing) {
    const firstReply = input.countsAsReply && conv.lastReplyAt === null && conv.firstResponseSeconds === null;
    await tx
      .update(conversations)
      .set({
        lastMessageAt: now,
        lastMessagePreview: previewOf(input.body),
        lastMessageKind: lastMessageKindOf(input.kind),
        lastMessageFileName: input.media?.fileName ?? null,
        lastMessageDurationSeconds: input.media?.durationSeconds ?? null,
        lastMessageDirection: "out",
        ...(input.countsAsReply ? { lastReplyAt: now } : {}),
        // responder lê: o contador de não lidas é da equipe, então só resposta de pessoa o zera
        ...(input.sender.kind === "member" ? { unreadCount: 0 } : {}),
        ...(firstReply ? { firstResponseSeconds: Math.max(0, Math.round((now.getTime() - conv.createdAt.getTime()) / 1000)) } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(conversations.id, conv.id));
  }
  // avisos só com ids, publicados depois do commit: a mensagem nova (se não é reenvio) e o resultado do envio
  if (!input.existing) queueRealtime(tx, conv.organizationId, { type: "conversation.message", conversationId: conv.id, direction: "out" });
  queueRealtime(tx, conv.organizationId, { type: "message.status", conversationId: conv.id, messageId: updated.id, status: result.ok ? "sent" : "failed" });
  return { message: updated, ok: result.ok, reconnect, reason };
}
