import { schema, withOrg, type Database } from "@duckzap/db";
import { and, desc, eq, gte, isNull, lte, isNotNull } from "drizzle-orm";
import type { ChannelRef, MessagingProvider } from "../../lib/messaging";
import { buildRef, findChannel } from "../channels/repo";
import { InMemoryTokenBucket, type RateLimiter } from "../channels/rate-limit";
import type { ChannelsRuntime } from "../channels/runtime";
import { isSendingPausedForOrg } from "../channels/sending";

const { conversations, messages, contacts } = schema;

/**
 * Visto azul no WhatsApp do cliente ("confirmação de leitura"): quando a equipe abre a conversa ou a IA responde, as mensagens
 * RECEBIDAS ainda não marcadas são marcadas como lidas no provedor. Melhor esforço: nenhuma falha chega ao atendimento.
 *
 * Marca de "já fiz isso": `messages.readAt` nas mensagens de ENTRADA (nas de saída ele é o "lida pelo cliente" do webhook). Não há
 * configuração de confirmação de leitura no produto, então ela sempre vale quando o canal sabe fazer.
 */

/** Mensagens por chamada (as mais recentes do cliente; marcar a última já marca as anteriores no aparelho dele). */
export const READ_RECEIPT_BATCH = 20;
/** Só vale marcar mensagem recente: abrir uma conversa antiga não deve acender "visto" em algo de meses atrás. */
export const READ_RECEIPT_WINDOW_MS = 7 * 86_400_000;

export type ReadReceiptChannels = Pick<ChannelsRuntime, "providers" | "config" | "now" | "log" | "background">;

export type ReadReceiptDeps = {
  db: Database;
  /** Função (e não o valor) porque o runtime de canais é montado depois: o padrão é o compartilhado do processo. */
  channels: () => ReadReceiptChannels;
  /** Freio por conversa para uma falha persistente do provedor não virar uma chamada a cada abertura da tela. */
  limiter: RateLimiter;
};

export function createReadReceiptLimiter(): RateLimiter {
  return new InMemoryTokenBucket({ capacity: 3, refillPerSecond: 1 / 20 });
}

type ReadTarget = { provider: MessagingProvider; ref: ChannelRef; to: string; ids: string[]; upTo: Date };

/**
 * Dentro da empresa, acha o que marcar: canal WhatsApp conectado com `markAsRead`, telefone do contato e as recebidas pendentes.
 * `null` = nada a fazer (conversa sem canal, canal que não é Evolution, plano suspenso, sem pendentes, contato sem telefone).
 */
async function resolveReadTarget(deps: ReadReceiptDeps, organizationId: string, conversationId: string): Promise<ReadTarget | null> {
  const channels = deps.channels();
  const now = channels.now();
  return withOrg(deps.db, organizationId, async (tx) => {
    const [conv] = await tx
      .select({ channelId: conversations.channelId, contactId: conversations.contactId })
      .from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId)))
      .limit(1);
    if (!conv?.channelId) return null;
    const channel = await findChannel(tx, organizationId, conv.channelId);
    if (!channel || channel.status !== "connected" || channel.type !== "whatsapp_qr") return null;
    const provider = channels.providers.get(channel.provider);
    if (!provider?.markAsRead) return null;
    if (await isSendingPausedForOrg(tx, now)) return null;

    // ids do provedor das recebidas (`externalId`), só do canal da conversa (o id vale na instância que o recebeu)
    const pending = await tx
      .select({ externalId: messages.externalId, createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.channelId, channel.id),
          eq(messages.direction, "in"),
          isNull(messages.readAt),
          isNotNull(messages.externalId),
          gte(messages.createdAt, new Date(now.getTime() - READ_RECEIPT_WINDOW_MS)),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(READ_RECEIPT_BATCH);
    const newest = pending[0];
    if (!newest) return null;
    const [contact] = await tx.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.id, conv.contactId)).limit(1);
    if (!contact?.phone) return null;
    return {
      provider,
      ref: buildRef(channel, channels),
      to: contact.phone,
      ids: pending.map((m) => m.externalId as string).reverse(),
      upTo: newest.createdAt,
    };
  });
}

/**
 * Marca como lidas, no WhatsApp do cliente, as mensagens recebidas ainda não marcadas da conversa. Nunca lança.
 *  - o provedor é chamado FORA de transação;
 *  - só depois do sucesso carimba `readAt` (até a mais nova enviada, inclusive as antigas que ficaram de fora do lote), então
 *    chamadas repetidas não marcam a mesma coisa duas vezes; se o provedor falhar nada é carimbado e a próxima abertura tenta de novo
 *    (limitada pelo `limiter`).
 */
export async function markInboundAsRead(deps: ReadReceiptDeps, organizationId: string, conversationId: string): Promise<"sent" | "skipped" | "failed"> {
  const log = deps.channels().log;
  try {
    const target = await resolveReadTarget(deps, organizationId, conversationId);
    if (!target) return "skipped";
    if (!(await deps.limiter.take(`${organizationId}:${conversationId}`)).allowed) return "skipped";
    try {
      await target.provider.markAsRead?.(target.ref, { to: target.to, messageIds: target.ids });
    } catch (error) {
      // telefone e ids são dado pessoal: só o tipo do erro
      log.warn("conversations.read_receipt.failed", { error: error instanceof Error ? error.name : "unknown" });
      return "failed";
    }
    const at = deps.channels().now();
    await withOrg(deps.db, organizationId, (tx) =>
      tx
        .update(messages)
        .set({ readAt: at })
        .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, "in"), isNull(messages.readAt), lte(messages.createdAt, target.upTo))),
    );
    return "sent";
  } catch (error) {
    log.warn("conversations.read_receipt.error", { error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

/** Dispara `markInboundAsRead` em segundo plano (a chamada ao provedor não segura a resposta da tela). */
export function markInboundAsReadInBackground(deps: ReadReceiptDeps, organizationId: string, conversationId: string) {
  deps.channels().background(async () => {
    await markInboundAsRead(deps, organizationId, conversationId);
  });
}
