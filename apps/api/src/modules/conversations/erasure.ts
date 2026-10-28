import { schema, type Transaction } from "@duckzap/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { registerContactErasureHook } from "../contacts/service";
import { eraseInboundEventsForPhones } from "../channels/inbound-store";

const { conversations, conversationAiEvents, copilotFeedback, aiUsageLog } = schema;

let registered = false;

/**
 * LGPD (§5.5): apagar o contato apaga em cascata conversas, mensagens e sugestões (FK ON DELETE CASCADE). As tabelas de
 * Agentes que guardam o id da conversa como TEXTO (auditoria da IA, feedback do Copiloto — que contém o texto sugerido —
 * e uso de tokens) não têm FK, então este hook as limpa na mesma transação, ANTES de o contato sumir.
 */
export async function eraseConversationData(tx: Transaction, organizationId: string, contactIds: string[]) {
  if (contactIds.length === 0) return;
  // eventos brutos de entrada (webhook) com o telefone do titular: minimiza antes de o contato sumir (precisa do telefone)
  const phones = await tx
    .select({ phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.organizationId, organizationId), inArray(schema.contacts.id, contactIds)));
  await eraseInboundEventsForPhones(tx, organizationId, phones.map((p) => p.phone));
  const ids = tx
    .select({ id: sql<string>`${conversations.id}::text` })
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), inArray(conversations.contactId, contactIds)));
  await tx.delete(conversationAiEvents).where(and(eq(conversationAiEvents.organizationId, organizationId), inArray(conversationAiEvents.conversationId, ids)));
  await tx.delete(copilotFeedback).where(and(eq(copilotFeedback.organizationId, organizationId), inArray(copilotFeedback.conversationId, ids)));
  await tx.delete(aiUsageLog).where(and(eq(aiUsageLog.organizationId, organizationId), inArray(aiUsageLog.conversationId, ids)));
}

export function registerConversationErasure() {
  if (registered) return;
  registered = true;
  registerContactErasureHook(eraseConversationData);
}
