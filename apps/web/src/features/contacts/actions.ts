"use server";

import {
  contactInputSchema,
  contactListInputSchema,
  exportRequestSchema,
  importCommitSchema,
  inviteRequestSchema,
  tagInputSchema,
  whatsappImportCommitSchema,
  whatsappImportStartSchema,
  type ContactInput,
  type ContactListInput,
  type ExportRequest,
  type ImportCommit,
  type ImportPreview,
  type ImportResult,
  type InviteRequest,
  type InviteResult,
  type TagInput,
  type WhatsappImportCommit,
  type WhatsappImportPreview,
} from "@duckzap/contracts/contacts";
import { isSendingPaused } from "@duckzap/contracts/session";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import * as api from "./api";

// Server Actions finas: sessão → validação → api.ts → revalidar. Nenhuma regra de negócio aqui.

export type ActionResult<T = null> = { ok: true; data: T } | { error: string };

const PATH = "/clientes";
const ids = z.array(z.string().min(1)).min(1, "Selecione ao menos um cliente.").max(5000);

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Confira os campos.";
}

export async function saveContactAction(id: string | null, input: ContactInput): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize("contact.edit");
  if ("error" in auth) return auth;
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = id ? await api.updateContact(id, parsed.data) : await api.createContact(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: { id: result.data.id } };
}

export async function addNoteAction(contactId: string, text: string): Promise<ActionResult> {
  const auth = await authorize("contact.edit");
  if ("error" in auth) return auth;
  const { session } = auth;
  const parsed = z.string().trim().min(1, "Escreva a nota antes de salvar.").max(2000).safeParse(text);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.addContactNote(z.string().parse(contactId), parsed.data, session.user.name);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: null };
}

export async function tagContactsAction(contactIds: string[], tagId: string): Promise<ActionResult<{ updated: number }>> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const parsed = ids.safeParse(contactIds);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.tagContacts(parsed.data, z.string().parse(tagId));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: result.data };
}

export async function addToListAction(contactIds: string[], listId: string): Promise<ActionResult<{ added: number }>> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const parsed = ids.safeParse(contactIds);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.addContactsToList(parsed.data, z.string().parse(listId));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: result.data };
}

export async function deleteContactsAction(contactIds: string[]): Promise<ActionResult<{ deleted: number }>> {
  const auth = await authorize("contact.delete");
  if ("error" in auth) return auth;
  const parsed = ids.safeParse(contactIds);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.deleteContacts(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: result.data };
}

export async function saveTagAction(id: string | null, input: TagInput): Promise<ActionResult> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const parsed = tagInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = id ? await api.updateTag(id, parsed.data) : await api.createTag(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: null };
}

export async function reorderTagsAction(orderedIds: string[]): Promise<ActionResult> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const result = await api.reorderTags(z.array(z.string()).parse(orderedIds));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: null };
}

export async function deleteTagAction(id: string): Promise<ActionResult> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const result = await api.deleteTag(z.string().parse(id));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: null };
}

export async function createListAction(input: ContactListInput): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const parsed = contactListInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.createContactList(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: { id: result.data.id } };
}

export async function deleteListAction(id: string): Promise<ActionResult> {
  const auth = await authorize("contact.bulk");
  if ("error" in auth) return auth;
  const result = await api.deleteContactList(z.string().parse(id));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: null };
}

export async function previewImportAction(formData: FormData): Promise<ActionResult<ImportPreview>> {
  const auth = await authorize("contact.import");
  if ("error" in auth) return auth;
  const file = formData.get("file");
  if (!(file instanceof File) || !file.name) return { error: "Escolha uma planilha em CSV." };
  if (!/\.(csv|txt)$/i.test(file.name)) return { error: "Formato não aceito. No Excel, use Arquivo → Salvar como → CSV e envie o arquivo .csv." };
  const result = await api.previewImport(file);
  if (!result.ok) return { error: result.message };
  return { ok: true, data: result.data };
}

export async function commitImportAction(commit: ImportCommit): Promise<ActionResult<ImportResult>> {
  const auth = await authorize("contact.import");
  if ("error" in auth) return auth;
  const parsed = importCommitSchema.safeParse(commit);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.commitImport(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: result.data };
}

/** Busca no WhatsApp do canal as pessoas que ele conhece (a pessoa revisa antes de importar). */
export async function previewWhatsappImportAction(channelId: string): Promise<ActionResult<WhatsappImportPreview>> {
  const auth = await authorize("contact.import");
  if ("error" in auth) return auth;
  const parsed = whatsappImportStartSchema.safeParse({ channelId });
  if (!parsed.success || !parsed.data.channelId) return { error: "Escolha o número do WhatsApp." };
  const result = await api.previewWhatsappImport(parsed.data.channelId);
  if (!result.ok) return { error: result.message };
  return { ok: true, data: result.data };
}

export async function commitWhatsappImportAction(commit: WhatsappImportCommit): Promise<ActionResult<ImportResult>> {
  const auth = await authorize("contact.import");
  if ("error" in auth) return auth;
  const parsed = whatsappImportCommitSchema.safeParse(commit);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.commitWhatsappImport(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: result.data };
}

export async function exportContactsAction(request: ExportRequest): Promise<ActionResult<{ fileName: string; csv: string; count: number }>> {
  const auth = await authorize("contact.export");
  if ("error" in auth) return auth;
  const parsed = exportRequestSchema.safeParse(request);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  return { ok: true, data: await api.exportContacts(parsed.data) };
}

export async function inviteContactsAction(request: InviteRequest): Promise<ActionResult<InviteResult>> {
  const auth = await authorize("campaign.send");
  if ("error" in auth) return auth;
  const { session } = auth;
  if (isSendingPaused(session)) return { error: "O envio está pausado porque o plano expirou. Regularize em Ajustes › Plano." };
  const parsed = inviteRequestSchema.safeParse(request);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.inviteContacts(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH, "layout");
  return { ok: true, data: result.data };
}
