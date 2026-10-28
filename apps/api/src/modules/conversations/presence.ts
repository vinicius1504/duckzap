import { schema, withOrg, type Database, type Transaction } from "@duckzap/db";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { publishRealtime } from "../../lib/realtime";
import type { PresenceContext } from "../../lib/presence";
import { findContactByPhone } from "../contacts/service";

const { conversations } = schema;

/**
 * Conversa ABERTA (não resolvida) do contato com este telefone, dentro da empresa do `tx` (RLS + filtro explícito).
 * Prefere a do mesmo canal; desempata pela atividade mais recente. Não cria nada: quem não é contato não tem conversa.
 */
export async function openConversationIdForPhone(tx: Transaction, organizationId: string, channelId: string, phone: string): Promise<string | null> {
  const contact = await findContactByPhone(tx, organizationId, phone);
  if (!contact) return null;
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.contactId, contact.id), ne(conversations.status, "resolved")))
    .orderBy(desc(sql`(${conversations.channelId} = ${channelId})`), desc(conversations.lastMessageAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * "Cliente digitando…" (presença que veio do provedor): acha a conversa aberta e avisa a tela em tempo real. Efêmero:
 * nada é gravado e o aviso leva só ids (o telefone fica aqui dentro e não é logado). Seguro para a empresa: a busca roda
 * em `withOrg` com a empresa do CANAL que recebeu o webhook.
 */
export async function handleContactPresence(db: Database, context: PresenceContext): Promise<void> {
  const conversationId = await withOrg(db, context.organizationId, (tx) => openConversationIdForPhone(tx, context.organizationId, context.channelId, context.from));
  if (!conversationId) return;
  publishRealtime(context.organizationId, {
    type: "typing",
    conversationId,
    actor: "contact",
    active: context.presence === "composing" || context.presence === "recording",
  });
}
