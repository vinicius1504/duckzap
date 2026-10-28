import "server-only";
import {
  assistantMessageSchema,
  helpCenterSchema,
  supportTicketSchema,
  type AssistantMessage,
  type HelpCenter,
  type SupportTicket,
  type SupportTicketInput,
} from "@duckzap/contracts/help";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/help): GET /v1/help?q=, POST /v1/help/ask, POST /v1/support/tickets,
// POST /v1/me/tour/restart. Conteúdo (FAQ, vídeos, textos do assistente) vive em apps/api/src/modules/help/content.ts.

type HelpError = "rate_limited" | "support_unavailable" | "unavailable";
const helpErrors = ["rate_limited", "support_unavailable"] as const satisfies readonly HelpError[];

/** Central de ajuda; `query` filtra as perguntas frequentes (pergunta ou resposta). */
export async function getHelpCenter(query?: string): Promise<HelpCenter> {
  const q = query?.trim();
  return readApi(`/v1/help${q ? `?q=${encodeURIComponent(q)}` : ""}`, helpCenterSchema);
}

/** Pergunta ao assistente de ajuda (IA sobre a documentação). */
export async function askHelpAssistant(question: string): Promise<Result<AssistantMessage>> {
  return callApi("/v1/help/ask", assistantMessageSchema, { method: "POST", body: { question }, errors: helpErrors, fallback: "unavailable" });
}

/** `userId` fica na assinatura por compatibilidade: a API usa a pessoa da sessão. */
export async function createSupportTicket(_userId: string, input: SupportTicketInput): Promise<Result<SupportTicket>> {
  return callApi("/v1/support/tickets", supportTicketSchema, { method: "POST", body: input, errors: helpErrors, fallback: "unavailable" });
}

/** Marca o tour guiado para aparecer de novo no próximo acesso ao Início. */
export async function restartProductTour(_userId: string): Promise<Result<null>> {
  return callApiVoid("/v1/me/tour/restart", { method: "POST", body: {}, errors: helpErrors, fallback: "unavailable" });
}
