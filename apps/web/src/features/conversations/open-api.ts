import "server-only";
import { z } from "zod";
import { callApi } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// "Abrir conversa" (POST /v1/conversations/open): acha, reabre ou cria a conversa com o cliente. Fica em arquivo próprio
// para não misturar com as demais chamadas do inbox (api.ts).

const openedSchema = z.object({ conversationId: z.string().min(1) });

export type OpenConversationError = "no_channel" | "not_found" | "in_service" | "sending_paused";

export async function openConversation(contactId: string): Promise<Result<{ conversationId: string }, OpenConversationError>> {
  return callApi("/v1/conversations/open", openedSchema, {
    method: "POST",
    body: { contactId },
    errors: ["no_channel", "not_found", "in_service", "sending_paused"] as const,
    fallback: "not_found",
  });
}
