import { conversationPrioritySchema, type InboxTab } from "@duckzap/contracts/conversations";
import { createSerializer, parseAsString, parseAsStringLiteral } from "nuqs/server";
import { z } from "zod";

// Estado do inbox na URL, em pt-BR: /conversas?aba=aguardando&visao=quadro&conversa=cv_carla
// Usado pelo server (page.tsx, com Zod) e pelo client (nuqs). `nuqs/server` não tem "use client".

export const TAB_SLUGS = ["minhas", "aguardando", "ia", "resolvidas"] as const;
export const VIEW_SLUGS = ["lista", "quadro"] as const;
export type TabSlug = (typeof TAB_SLUGS)[number];
export type ViewSlug = (typeof VIEW_SLUGS)[number];

export const tabFromSlug: Record<TabSlug, InboxTab> = {
  minhas: "mine",
  aguardando: "waiting",
  ia: "ai",
  resolvidas: "resolved",
};

export const inboxParsers = {
  tab: parseAsStringLiteral(TAB_SLUGS).withDefault("minhas"),
  view: parseAsStringLiteral(VIEW_SLUGS).withDefault("lista"),
  conversation: parseAsString,
  channel: parseAsString,
  team: parseAsString,
  tag: parseAsString,
  priority: parseAsStringLiteral(conversationPrioritySchema.options),
  q: parseAsString,
};

export const inboxUrlKeys = {
  tab: "aba",
  view: "visao",
  conversation: "conversa",
  channel: "canal",
  team: "equipe",
  tag: "etiqueta",
  priority: "prioridade",
  q: "busca",
} as const;

/** Monta o href mantendo os outros parâmetros: `inboxHref(searchParams, { conversation: id })`. */
export const serializeInbox = createSerializer(inboxParsers, { urlKeys: inboxUrlKeys, clearOnDefault: true });

export function inboxHref(base: { toString(): string }, values: Parameters<typeof serializeInbox>[1]) {
  return `/conversas${serializeInbox(new URLSearchParams(base.toString()), values)}`;
}

// validação do lado do server (searchParams chega como string | string[] | undefined)
const optionalId = z.string().min(1).max(64).optional().catch(undefined);

export const inboxSearchSchema = z.object({
  aba: z.enum(TAB_SLUGS).catch("minhas"),
  visao: z.enum(VIEW_SLUGS).catch("lista"),
  conversa: optionalId,
  canal: optionalId,
  equipe: optionalId,
  etiqueta: optionalId,
  prioridade: conversationPrioritySchema.optional().catch(undefined),
  busca: z.string().max(100).optional().catch(undefined),
});
export type InboxSearch = z.infer<typeof inboxSearchSchema>;
