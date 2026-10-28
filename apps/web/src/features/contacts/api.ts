import "server-only";
import {
  contactDetailSchema,
  contactListSchema,
  contactNoteSchema,
  contactPageSchema,
  contactSchema,
  importPreviewSchema,
  importResultSchema,
  inviteOverviewSchema,
  inviteResultSchema,
  tagSchema,
  whatsappImportPreviewSchema,
  type Contact,
  type ContactDetail,
  type ContactList,
  type ContactListInput,
  type ContactListQuery,
  type ContactNote,
  type ContactPage,
  type ExportRequest,
  type ImportCommit,
  type ImportPreview,
  type ImportResult,
  type InviteOverview,
  type InviteRequest,
  type InviteResult,
  type Tag,
  type TagInput,
  type WhatsappImportCommit,
  type WhatsappImportPreview,
  contactInputSchema,
} from "@duckzap/contracts/contacts";
import type { Channel } from "@duckzap/contracts/channels";
import { z } from "zod";
import { getChannelsOverview } from "@/features/channels/api";
import { get, readOrThrow, send, toResult, type CommonError } from "@/lib/api-result";
import { fail, ok, type Result } from "@/lib/mock";

// Ligado ao back (apps/api · modules/contacts). Cada função chama a rota correspondente, valida a resposta com o
// schema do contrato e mantém as assinaturas de antes. Erros de rede/permissão chegam como `Result` falho
// ("unavailable" / "forbidden"); leituras sem `Result` lançam e caem no error boundary da página.
// Rotas: GET /v1/contacts · /contacts/:id · /contacts/options · /contacts/owners · POST/PATCH /contacts ·
// POST /contacts/:id/notes · /contacts/bulk/{tag,list,delete} · /tags · /contact-lists ·
// POST /contacts/import/{preview,commit} · /contacts/import/whatsapp/{preview,commit} · /contacts/export · /contacts/invites{,/overview}.

export type ContactInputData = z.output<typeof contactInputSchema>;

const optionsSchema = z.array(z.object({ id: z.string(), name: z.string(), phone: z.string().nullable() }));
const ownersSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const exportSchema = z.object({ fileName: z.string(), csv: z.string(), count: z.number().int() });
const deletedSchema = z.object({ deleted: z.number().int() });
const updatedSchema = z.object({ updated: z.number().int() });
const addedSchema = z.object({ added: z.number().int() });
const emptySchema = z.object({}).passthrough();

const enc = encodeURIComponent;

function queryString(query: ContactListQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

// Contatos ---------------------------------------------------------------------------------------

export async function listContacts(query: ContactListQuery): Promise<ContactPage> {
  return readOrThrow(await get(`/v1/contacts?${queryString(query)}`), contactPageSchema);
}

export async function getContact(id: string): Promise<ContactDetail | null> {
  const call = await get(`/v1/contacts/${enc(id)}`);
  if (!call.ok && call.status === 404) return null;
  return readOrThrow(call, contactDetailSchema);
}

/** Opções enxutas para seletores (ex.: cliente no agendamento). */
export async function listContactOptions(): Promise<{ id: string; name: string; phone: string | null }[]> {
  return readOrThrow(await get("/v1/contacts/options"), optionsSchema);
}

export async function listContactOwners(): Promise<{ id: string; name: string }[]> {
  return readOrThrow(await get("/v1/contacts/owners"), ownersSchema);
}

export async function createContact(input: ContactInputData): Promise<Result<Contact, "duplicate" | "invalid" | CommonError>> {
  return toResult(await send("POST", "/v1/contacts", input), contactSchema, ["duplicate", "invalid"] as const);
}

export async function updateContact(id: string, input: ContactInputData): Promise<Result<Contact, "not_found" | "duplicate" | "invalid" | CommonError>> {
  return toResult(await send("PATCH", `/v1/contacts/${enc(id)}`, input), contactSchema, ["not_found", "duplicate", "invalid"] as const);
}

/** O autor da nota é a pessoa da sessão (o servidor ignora qualquer nome enviado). */
export async function addContactNote(contactId: string, text: string, _authorName: string): Promise<Result<ContactNote, "not_found" | CommonError>> {
  return toResult(await send("POST", `/v1/contacts/${enc(contactId)}/notes`, { text }), contactNoteSchema, ["not_found"] as const);
}

export async function tagContacts(contactIds: string[], tagId: string): Promise<Result<{ updated: number }, "not_found" | CommonError>> {
  return toResult(await send("POST", "/v1/contacts/bulk/tag", { contactIds, tagId }), updatedSchema, ["not_found"] as const);
}

export async function addContactsToList(contactIds: string[], listId: string): Promise<Result<{ added: number }, "not_found" | "segment" | CommonError>> {
  return toResult(await send("POST", "/v1/contacts/bulk/list", { contactIds, listId }), addedSchema, ["not_found", "segment"] as const);
}

/** Exclusão do titular (LGPD): remove contato, notas, histórico, consentimentos e agendamentos. */
export async function deleteContacts(contactIds: string[]): Promise<Result<{ deleted: number }, CommonError>> {
  return toResult(await send("POST", "/v1/contacts/bulk/delete", { contactIds }), deletedSchema, [] as const);
}

// Etiquetas --------------------------------------------------------------------------------------

export async function listTags(): Promise<Tag[]> {
  return readOrThrow(await get("/v1/tags"), z.array(tagSchema));
}

export async function createTag(input: TagInput): Promise<Result<Tag, "duplicate" | CommonError>> {
  return toResult(await send("POST", "/v1/tags", input), tagSchema, ["duplicate"] as const);
}

export async function updateTag(id: string, input: TagInput): Promise<Result<Tag, "not_found" | "duplicate" | CommonError>> {
  return toResult(await send("PATCH", `/v1/tags/${enc(id)}`, input), tagSchema, ["not_found", "duplicate"] as const);
}

/** Recebe a nova ordem completa. As 4 primeiras viram as etapas do funil. */
export async function reorderTags(orderedIds: string[]): Promise<Result<null, "invalid" | CommonError>> {
  const result = toResult(await send("PUT", "/v1/tags/order", { orderedIds }), emptySchema, ["invalid"] as const);
  return result.ok ? ok(null) : result;
}

export async function deleteTag(id: string): Promise<Result<null, "not_found" | "funnel_stage" | CommonError>> {
  const result = toResult(await send("DELETE", `/v1/tags/${enc(id)}`), emptySchema, ["not_found", "funnel_stage"] as const);
  return result.ok ? ok(null) : result;
}

// Listas e segmentos -----------------------------------------------------------------------------

export async function listContactLists(): Promise<ContactList[]> {
  return readOrThrow(await get("/v1/contact-lists"), z.array(contactListSchema));
}

export async function createContactList(input: ContactListInput): Promise<Result<ContactList, "duplicate" | CommonError>> {
  return toResult(await send("POST", "/v1/contact-lists", input), contactListSchema, ["duplicate"] as const);
}

export async function deleteContactList(id: string): Promise<Result<null, "not_found" | CommonError>> {
  const result = toResult(await send("DELETE", `/v1/contact-lists/${enc(id)}`), emptySchema, ["not_found"] as const);
  return result.ok ? ok(null) : result;
}

// Importação -------------------------------------------------------------------------------------

/**
 * Envia o arquivo (CSV) e devolve colunas + amostra. A leitura é no servidor. Planilhas .xlsx ainda não são
 * aceitas pela API (sem biblioteca instalada): a resposta orienta salvar como CSV.
 * Recebe o `File` do formulário (a Server Action repassa o próprio arquivo).
 */
export async function previewImport(
  file: { name: string; size: number },
): Promise<Result<ImportPreview, "empty" | "too_large" | "unsupported_format" | CommonError>> {
  if (file.size === 0) return fail("empty", "O arquivo está vazio.");
  if (file.size > 10 * 1024 * 1024) return fail("too_large", "O arquivo passa de 10 MB. Divida em partes menores.");
  if (!(file instanceof File)) return fail("unavailable", "Não foi possível ler o arquivo. Envie de novo.");
  const contentBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  return toResult(
    await send("POST", "/v1/contacts/import/preview", { fileName: file.name, contentBase64 }),
    importPreviewSchema,
    ["empty", "too_large", "unsupported_format"] as const,
  );
}

export async function commitImport(commit: ImportCommit): Promise<Result<ImportResult, "not_found" | "no_name" | "no_phone" | "invalid" | CommonError>> {
  return toResult(await send("POST", "/v1/contacts/import/commit", commit), importResultSchema, ["not_found", "no_name", "no_phone", "invalid"] as const);
}

// Importação do WhatsApp -------------------------------------------------------------------------

/** Canal WhatsApp por QR code, só com o que a tela de importação precisa. */
export type WhatsappImportChannel = Pick<Channel, "id" | "name" | "address" | "status">;

/** Canais WhatsApp por QR da empresa (os únicos que sabem a agenda do aparelho). `null` se Canais não respondeu. */
export async function listWhatsappImportChannels(): Promise<WhatsappImportChannel[] | null> {
  try {
    const { channels } = await getChannelsOverview();
    return channels
      .filter((c) => c.type === "whatsapp_qr")
      .map(({ id, name, address, status }) => ({ id, name, address, status }));
  } catch {
    return null;
  }
}

/** Busca no WhatsApp do canal as pessoas que ele conhece. Pode demorar alguns segundos. */
export async function previewWhatsappImport(
  channelId: string,
): Promise<
  Result<
    WhatsappImportPreview,
    "channel_not_found" | "channel_unsupported" | "channel_disconnected" | "provider_unavailable" | "invalid" | CommonError
  >
> {
  return toResult(
    await send("POST", "/v1/contacts/import/whatsapp/preview", { channelId }),
    whatsappImportPreviewSchema,
    ["channel_not_found", "channel_unsupported", "channel_disconnected", "provider_unavailable", "invalid"] as const,
  );
}

export async function commitWhatsappImport(
  commit: WhatsappImportCommit,
): Promise<Result<ImportResult, "not_found" | "too_large" | "invalid" | CommonError>> {
  return toResult(await send("POST", "/v1/contacts/import/whatsapp/commit", commit), importResultSchema, ["not_found", "too_large", "invalid"] as const);
}

// Exportação -------------------------------------------------------------------------------------

/** Devolve o conteúdo do CSV (`;` + BOM, com proteção contra injeção de fórmula). */
export async function exportContacts(request: ExportRequest): Promise<{ fileName: string; csv: string; count: number }> {
  return readOrThrow(await send("POST", "/v1/contacts/export", request), exportSchema);
}

// Convite de consentimento (§5.7 item 7) ---------------------------------------------------------

export async function getInviteOverview(): Promise<InviteOverview> {
  return readOrThrow(await get("/v1/contacts/invites/overview"), inviteOverviewSchema);
}

export async function inviteContacts(request: InviteRequest): Promise<Result<InviteResult, "channel_unavailable" | "none_eligible" | CommonError>> {
  return toResult(await send("POST", "/v1/contacts/invites", request), inviteResultSchema, ["channel_unavailable", "none_eligible"] as const);
}
