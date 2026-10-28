import { schema, type Database, type Transaction } from "@duckzap/db";
import type { LLMProvider } from "@duckzap/ai";
import { and, eq, gte, inArray } from "drizzle-orm";
import { chunk } from "../contacts/result";
import { getChannelsRuntime, type ChannelsRuntime } from "../channels/runtime";
import { InMemoryQueue, type Queue } from "../channels/queue";
import { randomRng, type Rng } from "./engine/rng";

// Portas do módulo Campanhas para o que ainda não existe (Conversas, checagem de número no provedor,
// fila persistente). Cada uma tem um padrão seguro; a integração troca por implementações reais.

export const RECENT_DAYS = 90;

/** Quem conversou com a empresa desde `since` (§5.7 item 1: priorizar os últimos 90 dias). */
export interface RecentContactsPort {
  recentContactIds(tx: Transaction, organizationId: string, contactIds: readonly string[], since: Date): Promise<Set<string>>;
}

/**
 * Padrão: quem tem conversa com `last_message_at >= since` (tabela `conversations`, módulo Conversas) OU
 * `contacts.last_interaction_at >= since` (mantido por `touchContactInteraction`). A união cobre contato importado
 * com histórico e conversa nova ainda sem o carimbo.
 */
export const contactsRecentPort: RecentContactsPort = {
  async recentContactIds(tx, organizationId, contactIds, since) {
    const out = new Set<string>();
    for (const part of chunk([...contactIds], 5000)) {
      const byInteraction = await tx
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.organizationId, organizationId), inArray(schema.contacts.id, part), gte(schema.contacts.lastInteractionAt, since)));
      for (const row of byInteraction) out.add(row.id);
      const byConversation = await tx
        .select({ id: schema.conversations.contactId })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.organizationId, organizationId), inArray(schema.conversations.contactId, part), gte(schema.conversations.lastMessageAt, since)));
      for (const row of byConversation) out.add(row.id);
    }
    return out;
  },
};

/** Checagem prévia "este número tem WhatsApp?" no provedor (§5.7 item 1). Chave ausente = não foi possível checar (mantém). */
export interface WhatsappCheckPort {
  check(input: { organizationId: string; channelId: string }, phones: readonly string[]): Promise<Map<string, boolean>>;
}

/** Padrão no-op: o `MessagingProvider` ainda não expõe checagem de número; ninguém é removido na prévia. */
export const noWhatsappCheck: WhatsappCheckPort = { check: async () => new Map() };

// Presença "digitando…" (§5.7 item 3) NÃO é mais uma porta: o runner passa `typingMs` dentro da `OutboundMessage` e o
// provedor com a capacidade `presence` (Evolution: campo nativo `delay`) mostra a presença e só então entrega.

export type CampaignPorts = {
  recent: RecentContactsPort;
  whatsappCheck: WhatsappCheckPort;
};

export const defaultCampaignPorts: CampaignPorts = { recent: contactsRecentPort, whatsappCheck: noWhatsappCheck };

export type TickJob = { organizationId: string; campaignId: string };

export type CampaignsRuntime = {
  db: Database;
  llm: LLMProvider;
  ports: CampaignPorts;
  channels: ChannelsRuntime;
  rng: Rng;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Fila de "acordar a campanha X no instante Y". Em memória hoje; BullMQ (job atrasado) quando houver Redis. */
  queue: Queue<TickJob>;
  log: { warn(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void };
};

export function createCampaignsRuntime(base: Pick<CampaignsRuntime, "db" | "llm">, overrides: Partial<CampaignsRuntime> = {}): CampaignsRuntime {
  const channels = overrides.channels ?? getChannelsRuntime();
  return {
    ports: defaultCampaignPorts,
    channels,
    rng: randomRng,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
    queue: new InMemoryQueue<TickJob>(),
    log: channels.log,
    ...base,
    ...overrides,
  };
}

let shared: CampaignsRuntime | null = null;
/** O runtime criado pelas rotas, para o sweep de fundo (src/jobs.ts) usar a mesma fila/portas. */
export function setSharedCampaignsRuntime(rt: CampaignsRuntime) {
  shared = rt;
}
export function getSharedCampaignsRuntime(): CampaignsRuntime | null {
  return shared;
}
