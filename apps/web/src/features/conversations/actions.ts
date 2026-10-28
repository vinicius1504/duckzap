"use server";

import {
  conversationModeSchema,
  scheduleAppointmentInputSchema,
  sendMessageInputSchema,
  suggestionRatingSchema,
  transferTargetSchema,
  type Message,
  type ReplySuggestion,
} from "@duckzap/contracts/conversations";
import { mediaUploadInitSchema, type MediaReady, type MediaUploadInitResult } from "@duckzap/contracts/media";
import { can, type Permission } from "@duckzap/contracts/permissions";
import { isSendingPaused, type Session } from "@duckzap/contracts/session";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import { validateMediaFile } from "@/lib/media";
import * as api from "./api";

// Server Actions finas: permissão → validação → acesso à conversa → api.ts → revalidar.

export type ActionError = { error: string };

const id = z.string().min(1).max(64);
const PATH = "/conversas";
const PAUSED = "Seu plano expirou. Você ainda vê as conversas, mas o envio fica pausado até renovar.";
const NO_ACCESS: ActionError = { error: "Você não tem acesso a esta conversa." };

type Ctx = { session: Session; actor: api.Actor; viewer: api.Viewer };

/** `authorize` + quem age/vê. Devolve `{ error }` sem permissão. */
async function gate(permission: Permission): Promise<Ctx | ActionError> {
  const auth = await authorize(permission);
  if ("error" in auth) return auth;
  const { session } = auth;
  return {
    session,
    actor: { id: session.user.id, name: session.user.name },
    viewer: { id: session.user.id, canViewAll: can(session.user.role, "conversation.view_all") },
  };
}

function done(result: { ok: true } | { ok: false; message: string }): ActionError | null {
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return null;
}

/** Permissão + id válido + acesso àquela conversa. */
async function gateConversation(permission: Permission, conversationId: string): Promise<(Ctx & { id: string }) | ActionError> {
  const ctx = await gate(permission);
  if ("error" in ctx) return ctx;
  const parsed = id.safeParse(conversationId);
  if (!parsed.success) return { error: "Conversa inválida." };
  if (!(await api.canAccessConversation(parsed.data, ctx.viewer))) return NO_ACCESS;
  return { ...ctx, id: parsed.data };
}

export async function markConversationReadAction(conversationId: string) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  return done(await api.markConversationRead(ctx.id));
}

export async function assumeConversationAction(conversationId: string) {
  const ctx = await gateConversation("conversation.assign", conversationId);
  if ("error" in ctx) return ctx;
  return done(await api.assumeConversation(ctx.id, ctx.actor));
}

export async function transferConversationAction(conversationId: string, target: unknown, note: string) {
  const ctx = await gateConversation("conversation.transfer", conversationId);
  if ("error" in ctx) return ctx;
  const parsedTarget = transferTargetSchema.safeParse(target);
  const parsedNote = z.string().trim().max(1000).safeParse(note);
  if (!parsedTarget.success) return { error: "Escolha para quem transferir." };
  if (!parsedNote.success) return { error: "A nota pode ter até 1.000 caracteres." };
  return done(await api.transferConversation(ctx.id, parsedTarget.data, ctx.actor, parsedNote.data || null));
}

export async function setConversationModeAction(conversationId: string, mode: string) {
  const ctx = await gateConversation("conversation.assign", conversationId);
  if ("error" in ctx) return ctx;
  const parsedMode = conversationModeSchema.safeParse(mode);
  if (!parsedMode.success) return { error: "Modo inválido." };
  return done(await api.setConversationMode(ctx.id, parsedMode.data, ctx.actor));
}

// resolver/reabrir: não há permissão própria na matriz; usamos conversation.reply (quem atende, encerra)
export async function resolveConversationAction(conversationId: string) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  return done(await api.resolveConversation(ctx.id, ctx.actor));
}

export async function reopenConversationAction(conversationId: string) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  return done(await api.reopenConversation(ctx.id, ctx.actor));
}

// etapa do funil é uma etiqueta do cliente: contact.edit
export async function moveConversationStageAction(conversationId: string, stageId: string) {
  const ctx = await gateConversation("contact.edit", conversationId);
  if ("error" in ctx) return ctx;
  const parsedStage = id.safeParse(stageId);
  if (!parsedStage.success) return { error: "Etapa inválida." };
  return done(await api.moveConversationStage(ctx.id, parsedStage.data));
}

export async function setContactTagsAction(contactId: string, tagIds: string[]) {
  const ctx = await gate("contact.edit");
  if ("error" in ctx) return ctx;
  const parsedId = id.safeParse(contactId);
  const parsedTags = z.array(id).max(20).safeParse(tagIds);
  if (!parsedId.success || !parsedTags.success) return { error: "Etiquetas inválidas." };
  if (!(await api.canAccessContact(parsedId.data, ctx.viewer))) return NO_ACCESS;
  return done(await api.setContactTags(parsedId.data, parsedTags.data));
}

export async function sendMessageAction(input: unknown): Promise<ActionError | { message: Message }> {
  const parsed = sendMessageInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Não deu para enviar esta mensagem." };
  const ctx = await gateConversation("conversation.reply", parsed.data.conversationId);
  if ("error" in ctx) return ctx;
  const data = parsed.data;
  if (data.kind !== "note" && isSendingPaused(ctx.session)) return { error: PAUSED };
  if ((data.kind === "text" || data.kind === "note") && !data.body.trim()) {
    return { error: data.kind === "note" ? "Escreva a nota antes de salvar." : "Escreva a mensagem antes de enviar." };
  }
  const result = await api.sendMessage({ ...data, body: data.body.trim() }, ctx.actor);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { message: result.data };
}

export async function resendMessageAction(conversationId: string, messageId: string) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  if (isSendingPaused(ctx.session)) return { error: PAUSED };
  const parsedMessage = id.safeParse(messageId);
  if (!parsedMessage.success) return { error: "Mensagem inválida." };
  return done(await api.resendMessage(ctx.id, parsedMessage.data));
}

export async function suggestReplyAction(conversationId: string): Promise<ActionError | { suggestion: ReplySuggestion }> {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  const result = await api.suggestReply(ctx.id);
  if (!result.ok) return { error: result.message };
  return { suggestion: result.data };
}

export async function rateSuggestionAction(suggestionId: string, rating: string) {
  const ctx = await gate("conversation.reply");
  if ("error" in ctx) return ctx;
  const parsedId = id.safeParse(suggestionId);
  const parsedRating = suggestionRatingSchema.safeParse(rating);
  if (!parsedId.success || !parsedRating.success) return { error: "Avaliação inválida." };
  const result = await api.rateSuggestion(parsedId.data, parsedRating.data);
  return result.ok ? null : { error: result.message };
}

// follow-up: sem permissão própria; usamos conversation.reply
export async function scheduleFollowUpAction(conversationId: string, scheduledAt: string) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  const parsedAt = z.iso.datetime().safeParse(scheduledAt);
  if (!parsedAt.success) return { error: "Escolha quando enviar o follow-up." };
  return done(await api.scheduleFollowUp(ctx.id, parsedAt.data));
}

export async function setFollowUpPausedAction(conversationId: string, paused: boolean) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  const parsedPaused = z.boolean().safeParse(paused);
  if (!parsedPaused.success) return { error: "Valor inválido." };
  return done(await api.setFollowUpPaused(ctx.id, parsedPaused.data));
}

export async function cancelFollowUpAction(conversationId: string) {
  const ctx = await gateConversation("conversation.reply", conversationId);
  if ("error" in ctx) return ctx;
  return done(await api.cancelFollowUp(ctx.id));
}

export async function scheduleAppointmentAction(input: unknown) {
  const parsed = scheduleAppointmentInputSchema.safeParse(input);
  if (!parsed.success) return { error: "Preencha tipo, dia, horário e profissional." };
  const ctx = await gateConversation("appointment.manage", parsed.data.conversationId);
  if ("error" in ctx) return ctx;
  if (new Date(parsed.data.startsAt).getTime() < Date.now()) return { error: "Escolha um horário no futuro." };
  return done(await api.scheduleAppointment(parsed.data, ctx.actor));
}

export async function updateContactNotesAction(contactId: string, notes: string) {
  const ctx = await gate("contact.edit");
  if ("error" in ctx) return ctx;
  const parsedId = id.safeParse(contactId);
  const parsedNotes = z.string().max(2000).safeParse(notes);
  if (!parsedId.success) return { error: "Cliente inválido." };
  if (!parsedNotes.success) return { error: "As notas podem ter até 2.000 caracteres." };
  if (!(await api.canAccessContact(parsedId.data, ctx.viewer))) return NO_ACCESS;
  return done(await api.updateContactNotes(parsedId.data, parsedNotes.data.trim()));
}

export async function setContactTaskDoneAction(taskId: string, isDone: boolean) {
  const ctx = await gate("contact.edit");
  if ("error" in ctx) return ctx;
  const parsedId = id.safeParse(taskId);
  const parsedDone = z.boolean().safeParse(isDone);
  if (!parsedId.success || !parsedDone.success) return { error: "Tarefa inválida." };
  if (!(await api.canAccessTask(parsedId.data, ctx.viewer))) return NO_ACCESS;
  return done(await api.setContactTaskDone(parsedId.data, parsedDone.data));
}

/**
 * "Digitando…" do atendente: chamada em segundo plano pelo campo de resposta (sem revalidar a tela, sem erro para a pessoa).
 * Só confere permissão; visibilidade, modo, plano e limite de frequência são decididos pela API.
 */
export async function sendTypingAction(conversationId: string): Promise<void> {
  const ctx = await gate("conversation.reply");
  if ("error" in ctx) return;
  const parsed = id.safeParse(conversationId);
  if (!parsed.success) return;
  await api.sendTyping(parsed.data);
}

// ── mídia: envio de arquivo em 3 passos (o navegador faz o PUT direto no armazenamento entre os dois) ──

/** Passo 1. Permissão de responder + plano ativo; tipo e tamanho são conferidos aqui e de novo pela API. */
export async function initMediaUploadAction(input: unknown): Promise<ActionError | { upload: MediaUploadInitResult }> {
  const ctx = await gate("conversation.reply");
  if ("error" in ctx) return ctx;
  if (isSendingPaused(ctx.session)) return { error: PAUSED };
  const parsed = mediaUploadInitSchema.safeParse(input);
  if (!parsed.success) return { error: "Não deu para preparar o envio deste arquivo." };
  const check = validateMediaFile(parsed.data.kind, { name: parsed.data.fileName, type: parsed.data.mimeType, size: parsed.data.sizeBytes });
  if (!check.ok) return { error: check.message };
  const result = await api.initMediaUpload(parsed.data);
  return result.ok ? { upload: result.data } : { error: result.message };
}

/** Passo 3. A API confere o arquivo guardado (tipo real e tamanho) e só então o `mediaId` pode ir numa mensagem. */
export async function completeMediaUploadAction(mediaId: string): Promise<ActionError | { media: MediaReady }> {
  const ctx = await gate("conversation.reply");
  if ("error" in ctx) return ctx;
  const parsed = id.safeParse(mediaId);
  if (!parsed.success) return { error: "Arquivo inválido." };
  const result = await api.completeMediaUpload(parsed.data);
  return result.ok ? { media: result.data } : { error: result.message };
}
