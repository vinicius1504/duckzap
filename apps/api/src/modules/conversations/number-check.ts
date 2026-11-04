import { schema, withOrg, type Database } from "@duckzap/db";
import { and, eq, ne } from "drizzle-orm";
import type { ChannelRef, MessagingProvider } from "../../lib/messaging";
import { buildRef, findSendChannel } from "../channels/repo";
import { InMemoryTokenBucket, type RateLimiter } from "../channels/rate-limit";
import type { ChannelsRuntime } from "../channels/runtime";
import { isSendingPausedForOrg } from "../channels/sending";
import { isGuid } from "../contacts/http";

const { contacts, conversations, messages } = schema;

/**
 * "Este número tem WhatsApp?" antes de abrir uma conversa NOVA com um contato (POST /v1/conversations/open).
 * Só bloqueia com `exists: false` dito pelo provedor; erro, lentidão, canal sem a capacidade ou limite de chamadas = segue
 * normalmente (a regra de envio e o próprio provedor continuam sendo a última barreira).
 */
export const NO_WHATSAPP_MESSAGE = "Este número não tem WhatsApp.";

export type NumberCheckChannels = Pick<ChannelsRuntime, "providers" | "config" | "now" | "log">;

export type NumberCheckDeps = {
  db: Database;
  /** Função porque o runtime de canais é montado depois: o padrão é o compartilhado do processo. */
  channels: () => NumberCheckChannels;
  /** Chamada disparada pelo usuário: balde por empresa (a ficha do cliente não deve virar uma metralhadora de consultas). */
  limiter: RateLimiter;
};

export function createNumberCheckLimiter(): RateLimiter {
  return new InMemoryTokenBucket({ capacity: 10, refillPerSecond: 0.5 });
}

export type NumberCheckOutcome =
  /** Nada a conferir (já há conversa, o contato já escreveu, canal sem a capacidade…) ou não foi possível conferir. */
  | { kind: "skip" }
  /** `jid` é o endereço real no WhatsApp (pode ter número diferente do digitado, ex.: 9º dígito). */
  | { kind: "has_whatsapp"; jid: string | null }
  | { kind: "no_whatsapp" };

type CheckTarget = { provider: MessagingProvider; ref: ChannelRef; number: string };

/** Dentro da empresa: precisa conferir este contato? Devolve o provedor+canal e o número, ou `null` (nada a fazer). */
async function resolveCheckTarget(deps: NumberCheckDeps, organizationId: string, contactId: string): Promise<CheckTarget | null> {
  const channels = deps.channels();
  return withOrg(deps.db, organizationId, async (tx) => {
    const [contact] = await tx
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
      .limit(1);
    const number = contact?.phone?.replace(/\D/g, "") ?? "";
    if (!contact || number.length < 8) return null;

    // conversa aberta: "abrir" só devolve o id dela, não há envio novo
    const [open] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.contactId, contact.id), ne(conversations.status, "resolved")))
      .limit(1);
    if (open) return null;
    // quem já nos escreveu provou ter WhatsApp: não gasta consulta
    const [inbound] = await tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.organizationId, organizationId), eq(conversations.contactId, contact.id), eq(messages.direction, "in")))
      .limit(1);
    if (inbound) return null;

    // mesmo canal que "abrir" vai usar; plano suspenso: o próprio "abrir" recusa
    if (await isSendingPausedForOrg(tx, channels.now())) return null;
    const channel = await findSendChannel(tx, organizationId, null);
    if (!channel || channel.status !== "connected" || channel.type !== "whatsapp_qr") return null;
    const provider = channels.providers.get(channel.provider);
    if (!provider?.checkNumbers) return null;
    return { provider, ref: buildRef(channel, channels), number };
  });
}

/** Confere o número do contato no provedor (FORA de transação). Nunca lança; qualquer dúvida vira `skip`. */
export async function checkContactWhatsapp(deps: NumberCheckDeps, organizationId: string, contactId: string): Promise<NumberCheckOutcome> {
  const log = deps.channels().log;
  try {
    if (!isGuid(contactId)) return { kind: "skip" };
    const target = await resolveCheckTarget(deps, organizationId, contactId);
    if (!target) return { kind: "skip" };
    if (!(await deps.limiter.take(organizationId)).allowed) return { kind: "skip" };
    const results = await target.provider.checkNumbers?.(target.ref, { numbers: [target.number] });
    // a Evolution pode devolver o número já corrigido (9º dígito): com um só pedido, a única resposta é a nossa
    const answer = results?.find((r) => r.number === target.number) ?? (results?.length === 1 ? results[0] : undefined);
    if (!answer) return { kind: "skip" };
    return answer.exists ? { kind: "has_whatsapp", jid: answer.jid } : { kind: "no_whatsapp" };
  } catch (error) {
    // telefone é dado pessoal: só o tipo do erro
    log.warn("conversations.number_check.failed", { error: error instanceof Error ? error.name : "unknown" });
    return { kind: "skip" };
  }
}
