import "server-only";
import {
  contactAppointmentSchema,
  conversationDetailSchema,
  conversationListSchema,
  inboxLookupsSchema,
  messageSchema,
  replySuggestionSchema,
  type ContactAppointment,
  type ConversationDetail,
  type ConversationList,
  type ConversationMode,
  type InboxFilters,
  type InboxLookups,
  type Message,
  type ReplySuggestion,
  type ScheduleAppointmentInput,
  type SendMessageInput,
  type SuggestionRating,
  type TransferTarget,
} from "@duckzap/contracts/conversations";
import { mediaReadySchema, mediaUploadInitResultSchema, type MediaReady, type MediaUploadInit, type MediaUploadInitResult } from "@duckzap/contracts/media";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/conversations): /v1/inbox/*, /v1/conversations/*. Assinaturas mantidas.
//  - Quem vê o quê (conversation.view_all), permissões, plano expirado (envio pausado) e acesso a cada conversa/cliente/
//    tarefa são decididos NO SERVIDOR a partir da sessão. O `viewer` e o `actor` recebidos aqui só existem para manter as
//    assinaturas das Server Actions: a API ignora o que a tela diz sobre quem é a pessoa.
//  - Sem tempo real ainda: a tela atualiza ao navegar e a cada ação (revalidatePath). Status de entrega (entregue/lida)
//    chega por eventos do provedor e aparece na próxima leitura.

/** Quem faz a ação (vem da sessão no actions.ts). */
export type Actor = { id: string; name: string };

/**
 * Quem está vendo. Sem `canViewAll` (permissão conversation.view_all) a pessoa só vê o que é dela,
 * a fila (Aguardando) e as conversas sem responsável das suas equipes. O back aplica a mesma regra.
 */
export type Viewer = { id: string; canViewAll: boolean };

const enc = encodeURIComponent;
const none = [] as readonly string[];

// ── leitura ─────────────────────────────────────────────────────────────────

export async function getInboxLookups(): Promise<InboxLookups> {
  return readApi("/v1/inbox/lookups", inboxLookupsSchema);
}

export async function listConversations(filters: InboxFilters, _viewer: Viewer): Promise<ConversationList> {
  const params = new URLSearchParams({ tab: filters.tab });
  if (filters.channelId) params.set("channelId", filters.channelId);
  if (filters.teamId) params.set("teamId", filters.teamId);
  if (filters.tagId) params.set("tagId", filters.tagId);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.search) params.set("search", filters.search);
  return readApi(`/v1/conversations?${params}`, conversationListSchema);
}

/** null quando não existe ou quando quem vê não tem acesso (a tela trata igual). */
export async function getConversation(id: string, _viewer: Viewer): Promise<ConversationDetail | null> {
  const result = await callApi(`/v1/conversations/${enc(id)}`, conversationDetailSchema, { errors: ["not_found"] as const, fallback: "unavailable" as const });
  if (result.ok) return result.data;
  if (result.error === "not_found") return null;
  throw new Error(result.message);
}

/** Só "não alcança" (404) nega; se a API estiver fora, deixa a própria ação falhar com a mensagem certa. */
async function reaches(path: string): Promise<boolean> {
  const result = await callApiVoid(path, { errors: ["not_found"] as const, fallback: "unavailable" as const });
  return result.ok || result.error !== "not_found";
}

/** Checagem de acesso para as mutações (o back faz o mesmo em cada rota). */
export async function canAccessConversation(id: string, _viewer: Viewer): Promise<boolean> {
  return reaches(`/v1/inbox/access/conversation/${enc(id)}`);
}

/** Checagem de acesso pelo cliente (notas, tarefas, etiquetas). */
export async function canAccessContact(contactId: string, _viewer: Viewer): Promise<boolean> {
  return reaches(`/v1/inbox/access/contact/${enc(contactId)}`);
}

/** Checagem pela tarefa do cliente. */
export async function canAccessTask(taskId: string, _viewer: Viewer): Promise<boolean> {
  return reaches(`/v1/inbox/access/task/${enc(taskId)}`);
}

// ── ações sobre a conversa ──────────────────────────────────────────────────

export async function markConversationRead(id: string): Promise<Result<null>> {
  return callApiVoid(`/v1/conversations/${enc(id)}/read`, { method: "POST", errors: none, fallback: "error" });
}

/** "Assumir": a pessoa vira responsável e a IA deixa de responder sozinha. */
export async function assumeConversation(id: string, _actor: Actor): Promise<Result<null, "not_found" | "resolved">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/assume`, { method: "POST", errors: ["not_found", "resolved"] as const, fallback: "not_found" });
}

export async function transferConversation(
  id: string,
  target: TransferTarget,
  _actor: Actor,
  note: string | null,
): Promise<Result<null, "not_found" | "invalid_target">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/transfer`, {
    method: "POST",
    body: { target, note },
    errors: ["not_found", "invalid_target"] as const,
    fallback: "invalid_target",
  });
}

export async function setConversationMode(id: string, mode: ConversationMode, _actor: Actor): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/mode`, { method: "POST", body: { mode }, errors: ["not_found"] as const, fallback: "not_found" });
}

export async function resolveConversation(id: string, _actor: Actor): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/resolve`, { method: "POST", errors: ["not_found"] as const, fallback: "not_found" });
}

export async function reopenConversation(id: string, _actor: Actor): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/reopen`, { method: "POST", errors: ["not_found"] as const, fallback: "not_found" });
}

export async function moveConversationStage(id: string, stageId: string): Promise<Result<null, "not_found" | "invalid_stage">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/stage`, {
    method: "POST",
    body: { stageId },
    errors: ["not_found", "invalid_stage"] as const,
    fallback: "invalid_stage",
  });
}

/** Etiquetas do cliente (sem as etapas, que mudam por `moveConversationStage`). */
export async function setContactTags(contactId: string, tagIds: string[]): Promise<Result<null, "invalid_tag">> {
  return callApiVoid(`/v1/inbox/contacts/${enc(contactId)}/tags`, {
    method: "POST",
    body: { tagIds },
    errors: ["invalid_tag"] as const,
    fallback: "invalid_tag",
  });
}

// ── mensagens ───────────────────────────────────────────────────────────────

/**
 * Envia (ou salva a nota). Plano expirado → o servidor recusa (403) e o erro volta como falha. Canal desconectado NÃO é erro:
 * a mensagem volta com `status: "failed"` e o motivo, para a tela oferecer o reenvio.
 */
export async function sendMessage(input: SendMessageInput, _actor: Actor): Promise<Result<Message, "not_found" | "resolved">> {
  return callApi(`/v1/conversations/${enc(input.conversationId)}/messages`, messageSchema, {
    method: "POST",
    body: { kind: input.kind, body: input.body, attachment: input.attachment, clientId: input.clientId },
    errors: ["not_found", "resolved"] as const,
    fallback: "not_found",
  });
}

export async function resendMessage(
  conversationId: string,
  messageId: string,
): Promise<Result<Message, "not_found" | "not_failed" | "channel_down">> {
  return callApi(`/v1/conversations/${enc(conversationId)}/messages/${enc(messageId)}/resend`, messageSchema, {
    method: "POST",
    errors: ["not_found", "not_failed", "channel_down"] as const,
    fallback: "channel_down",
  });
}

// ── copiloto ────────────────────────────────────────────────────────────────

export async function suggestReply(conversationId: string): Promise<Result<ReplySuggestion, "not_found">> {
  return callApi(`/v1/conversations/${enc(conversationId)}/suggestions`, replySuggestionSchema, {
    method: "POST",
    errors: ["not_found"] as const,
    fallback: "not_found",
  });
}

export async function rateSuggestion(suggestionId: string, rating: SuggestionRating): Promise<Result<null>> {
  return callApiVoid(`/v1/inbox/suggestions/${enc(suggestionId)}/rating`, { method: "POST", body: { rating }, errors: none, fallback: "error" });
}

// ── follow-up ───────────────────────────────────────────────────────────────

export async function scheduleFollowUp(id: string, scheduledAt: string): Promise<Result<null, "not_found" | "in_past">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/follow-up`, {
    method: "POST",
    body: { scheduledAt },
    errors: ["not_found", "in_past"] as const,
    fallback: "in_past",
  });
}

export async function setFollowUpPaused(id: string, paused: boolean): Promise<Result<null, "not_found" | "no_follow_up">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/follow-up`, {
    method: "PATCH",
    body: { paused },
    errors: ["not_found", "no_follow_up"] as const,
    fallback: "no_follow_up",
  });
}

export async function cancelFollowUp(id: string): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/conversations/${enc(id)}/follow-up`, { method: "DELETE", errors: ["not_found"] as const, fallback: "not_found" });
}

// ── cliente ─────────────────────────────────────────────────────────────────

/** Usa a Agenda de verdade (inclusive a checagem de conflito do profissional). */
export async function scheduleAppointment(
  input: ScheduleAppointmentInput,
  _actor: Actor,
): Promise<Result<ContactAppointment, "not_found" | "invalid_type" | "conflict">> {
  return callApi(`/v1/conversations/${enc(input.conversationId)}/appointments`, contactAppointmentSchema, {
    method: "POST",
    body: { appointmentTypeId: input.appointmentTypeId, startsAt: input.startsAt, professional: input.professional },
    errors: ["not_found", "invalid_type", "conflict"] as const,
    fallback: "invalid_type",
  });
}

export async function updateContactNotes(contactId: string, notes: string): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/inbox/contacts/${enc(contactId)}/notes`, { method: "PATCH", body: { notes }, errors: ["not_found"] as const, fallback: "not_found" });
}

export async function setContactTaskDone(taskId: string, done: boolean): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/inbox/tasks/${enc(taskId)}`, { method: "PATCH", body: { done }, errors: ["not_found"] as const, fallback: "not_found" });
}

// ── "digitando…" ────────────────────────────────────────────────────────────

/**
 * Avisa a API que a pessoa está digitando uma resposta; ela mostra "digitando…" no WhatsApp do cliente (quando o canal
 * suporta). Melhor esforço, 204 sem corpo: a API decide se vale (IA respondendo, plano, canal) e limita a frequência.
 */
export async function sendTyping(conversationId: string): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/conversations/${enc(conversationId)}/typing`, { method: "POST", errors: ["not_found"] as const, fallback: "not_found" });
}

// ── mídia (módulo media da API) ─────────────────────────────────────────────

/** Passo 1 do envio de arquivo: a API valida tipo/tamanho e devolve a URL assinada para o navegador fazer o PUT. */
export async function initMediaUpload(input: MediaUploadInit): Promise<Result<MediaUploadInitResult>> {
  return callApi("/v1/media/uploads", mediaUploadInitResultSchema, { method: "POST", body: input, errors: none, fallback: "error" });
}

/** Passo 3: a API lê o arquivo guardado, confere o tipo real e o tamanho; só então o mediaId pode ir numa mensagem. */
export async function completeMediaUpload(mediaId: string): Promise<Result<MediaReady>> {
  return callApi(`/v1/media/uploads/${enc(mediaId)}/complete`, mediaReadySchema, { method: "POST", errors: none, fallback: "error" });
}
