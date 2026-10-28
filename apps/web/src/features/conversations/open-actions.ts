"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import { openConversation } from "./open-api";

/** Erro mostrado junto ao botão. `code` deixa a tela oferecer o atalho certo (ex.: ir para Canais). */
export type OpenConversationActionError = { error: string; code?: "no_channel" };

/**
 * "Abrir conversa" na ficha do cliente e na agenda: abre a conversa que já existe, reabre a recente ou cria uma vazia,
 * e leva para ela. Sem canal conectado devolve o aviso (não redireciona).
 */
export async function openConversationAction(contactId: string): Promise<OpenConversationActionError | undefined> {
  const auth = await authorize("conversation.reply");
  if ("error" in auth) return auth;
  const parsed = z.uuid().safeParse(contactId);
  if (!parsed.success) return { error: "Cliente não encontrado." };
  const result = await openConversation(parsed.data);
  if (!result.ok) return { error: result.message, ...(result.error === "no_channel" ? { code: "no_channel" as const } : {}) };
  redirect(`/conversas?conversa=${encodeURIComponent(result.data.conversationId)}`);
}
