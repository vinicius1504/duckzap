import { schema, type Transaction } from "@duckzap/db";
import { z } from "zod";
import { and, desc, eq, gte, isNull, ne, or } from "drizzle-orm";
import { queueRealtime } from "../../lib/realtime";
import { findSendChannel, isUniqueViolation } from "../channels/repo";
import { isGuid } from "../contacts/http";
import { fail, newId, ok, type Result } from "../contacts/result";
import { routeNewConversation } from "./inbound";
import { isVisibleTo } from "./logic";
import { addEvent, auditState } from "./outbound";
import { loadViewer, statusOf, type ConvCtx } from "./queries";

const { conversations, contacts } = schema;

export const openBodySchema = z.object({ contactId: z.uuid("Escolha um cliente.") });

/**
 * "Abrir conversa" a partir da ficha do cliente / agenda (POST /v1/conversations/open).
 *
 *  1. o cliente já tem conversa ABERTA (em qualquer canal)  → devolve o id dela (nada muda);
 *  2. senão, há uma RESOLVIDA dentro da janela de reabertura (a mesma do pipeline de entrada) → reabre, com a pessoa como responsável;
 *  3. senão, cria uma conversa vazia no canal WhatsApp padrão CONECTADO, com a pessoa como responsável (human_active, modo
 *     "Só humano": a IA não responde a um chat vazio) e a linha "<nome> iniciou a conversa" na linha do tempo.
 *
 * Sem canal conectado → `no_channel`. Cliente de outra empresa ou inexistente → `not_found` (nunca revela existência).
 * Cliente sem WhatsApp ou que pediu para sair PODE ter a conversa aberta: quem manda ou barra o envio é a regra de envio.
 * Duas chamadas simultâneas criam UMA conversa: o índice único parcial decide e quem perde relê a vencedora.
 */
export type OpenOutcome = { conversationId: string; outcome: "existing" | "reopened" | "created" };
export type OpenError = "not_found" | "no_channel" | "in_service" | "sending_paused";

export const NO_CHANNEL_TO_OPEN = "Conecte um canal em Canais para conversar com este contato.";

export async function openConversationForContact(
  tx: Transaction,
  organizationId: string,
  actor: ConvCtx,
  contactId: string,
  options: { reopenWindowDays?: number; now?: Date } = {},
): Promise<Result<OpenOutcome, OpenError>> {
  const now = options.now ?? new Date();
  const windowDays = options.reopenWindowDays ?? 7;
  if (!isGuid(contactId)) return fail("not_found", "Cliente não encontrado.");
  // RLS já filtra por empresa; o filtro explícito é defesa em profundidade
  const [contact] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
    .limit(1);
  if (!contact) return fail("not_found", "Cliente não encontrado.");

  const channel = await findSendChannel(tx, organizationId, null);

  // 1. já existe conversa aberta (em qualquer canal)
  const existing = async (): Promise<Result<OpenOutcome, "in_service"> | null> => {
    const [open] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.contactId, contactId), ne(conversations.status, "resolved")))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1)
      .for("update");
    if (!open) return null;
    const viewer = await loadViewer(tx, actor);
    if (!isVisibleTo({ assigneeId: open.assigneeId, status: statusOf(open), teamId: open.teamId }, viewer)) {
      return fail("in_service", "Este cliente já está sendo atendido por outra pessoa da equipe.");
    }
    // conversa que ficou sem canal (o canal foi apagado): passa a usar o canal conectado, como na entrada de mensagens
    if (open.channelId === null && channel) {
      await tx.update(conversations).set({ channelId: channel.id, updatedAt: now }).where(eq(conversations.id, open.id));
    }
    return ok({ conversationId: open.id, outcome: "existing" as const });
  };
  const found = await existing();
  if (found) return found;

  // abrir/criar/reabrir é escrever: sem canal conectado ou com o envio pausado (plano vencido) não há o que iniciar
  if (!channel) return fail("no_channel", NO_CHANNEL_TO_OPEN);
  if (actor.sendingPaused) return fail("sending_paused", "Seu plano expirou. Você ainda vê as conversas, mas não pode iniciar novas até renovar.");

  // 2. resolvida há pouco: reabre (mesma regra da entrada: mesmo canal ou sem canal, dentro da janela)
  const windowMs = windowDays * 86_400_000;
  if (windowMs > 0) {
    const [recent] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.contactId, contactId),
          or(eq(conversations.channelId, channel.id), isNull(conversations.channelId)),
          eq(conversations.status, "resolved"),
          gte(conversations.resolvedAt, new Date(now.getTime() - windowMs)),
        ),
      )
      .orderBy(desc(conversations.resolvedAt))
      .limit(1)
      .for("update");
    if (recent) {
      try {
        // savepoint: se uma mensagem do cliente abriu outra conversa um instante antes, o índice único recusa e relemos
        const reopened = await tx.transaction(async (sp) => {
          const [row] = await sp
            .update(conversations)
            .set({
              status: "human_active",
              resolvedBy: null,
              resolvedAt: null,
              assigneeId: actor.userId,
              waitingSince: null,
              aiDueAt: null,
              channelId: recent.channelId ?? channel.id,
              updatedAt: now,
            })
            .where(eq(conversations.id, recent.id))
            .returning();
          return row;
        });
        if (reopened) {
          await addEvent(tx, reopened, `${actor.userName} reabriu a conversa`, now);
          await auditState(tx, reopened, { from: "resolved", to: "human_active", event: "human_took_over", actor: "human", reason: "reaberta pela equipe", userId: actor.userId });
          queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: reopened.id, reason: "reopened" });
          queueRealtime(tx, organizationId, { type: "home.invalidate" });
          return ok({ conversationId: reopened.id, outcome: "reopened" as const });
        }
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await existing();
        if (raced) return raced;
        throw error;
      }
    }
  }

  // 3. cria a conversa vazia
  const routing = await routeNewConversation(tx, organizationId, channel);
  const inserted = await tx
    .insert(conversations)
    .values({
      id: newId(),
      organizationId,
      contactId,
      channelId: channel.id,
      teamId: routing.teamId,
      agentId: routing.agent?.id ?? null,
      assigneeId: actor.userId,
      status: "human_active",
      // a conversa nasce vazia: a IA não deve "responder" a ninguém; a pessoa pode devolvê-la à IA depois
      mode: "human",
      lastMessagePreview: "Conversa iniciada",
      createdAt: now,
      lastMessageAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const created = inserted[0];
  if (!created) {
    // outra chamada (ou uma mensagem do cliente) criou a conversa um instante antes: usa a dela
    const raced = await existing();
    if (raced) return raced;
    throw new Error("conversa não encontrada nem criada");
  }
  await addEvent(tx, created, `${actor.userName} iniciou a conversa`, now);
  await auditState(tx, created, { from: "resolved", to: "human_active", event: "human_took_over", actor: "human", reason: "conversa iniciada pela equipe", userId: actor.userId });
  queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: created.id, reason: "other" });
  queueRealtime(tx, organizationId, { type: "home.invalidate" });
  return ok({ conversationId: created.id, outcome: "created" as const });
}
