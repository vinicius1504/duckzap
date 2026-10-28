import {
  FUNNEL_STAGE_COUNT,
  consentSchema,
  contactEventSchema,
  tagColorSchema,
  contactOriginSchema,
  type Consent,
  type ContactFilter,
  type ConsentStatus,
  type Contact,
  type ContactDetail,
  type ContactList,
  type ContactListInput,
  type ContactListQuery,
  type ContactNote,
  type ContactPage,
  type Tag,
  type TagInput,
  contactInputSchema,
} from "@duckzap/contracts/contacts";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, count, desc, eq, inArray, max, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { effectiveConsentStatus, inviteCutoff, interpretConsentReply, nextConsentStatus, type ReplyIntent } from "./consent";
import { buildContactCondition, buildListCondition, parseFilter } from "./filter";
import { normalizePhone } from "./phone";
import { PG_UNIQUE_VIOLATION, fail, newId, ok, pgErrorCode, type Result, type ServiceCtx } from "./result";

const { contacts, tags, contactTags, contactLists, contactListMembers, contactNotes, contactEvents, consents, member, user } = schema;

export type ContactInputData = z.output<typeof contactInputSchema>;
type ContactRow = typeof contacts.$inferSelect;
type ConsentRow = typeof consents.$inferSelect;
type EventKind = z.infer<typeof contactEventSchema>["kind"];

const normalizeText = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// Mapeamento linha → contrato -------------------------------------------------------------------------------

export function consentToDto(row: ConsentRow | null | undefined, now: Date): Consent | null {
  if (!row) return null;
  return {
    status: effectiveConsentStatus(row, now),
    method: consentSchema.shape.method.catch("invite").parse(row.method),
    updatedAt: row.updatedAt.toISOString(),
    inviteSentAt: row.inviteSentAt?.toISOString() ?? null,
    inviteText: row.inviteText,
    replyText: row.replyText,
    repliedAt: row.repliedAt?.toISOString() ?? null,
    channelName: row.channelName,
  };
}

export function contactToDto(row: ContactRow, extra: { tagIds: string[]; listIds: string[]; consent: Consent | null }): Contact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    instagram: row.instagram,
    channel: row.phone ? "whatsapp" : "instagram",
    isCustomer: row.isCustomer,
    tagIds: extra.tagIds,
    listIds: extra.listIds,
    origin: contactOriginSchema.nullable().catch(null).parse(row.origin),
    originNote: row.originNote,
    consent: extra.consent,
    ownerId: row.ownerId,
    birthDate: row.birthDate,
    createdAt: row.createdAt.toISOString(),
    lastInteractionAt: row.lastInteractionAt?.toISOString() ?? null,
  };
}

async function relationsFor(tx: Transaction, contactIds: string[]) {
  const tagIds = new Map<string, string[]>();
  const listIds = new Map<string, string[]>();
  if (contactIds.length === 0) return { tagIds, listIds };
  const [tagRows, listRows] = await Promise.all([
    tx.select({ contactId: contactTags.contactId, tagId: contactTags.tagId }).from(contactTags).where(inArray(contactTags.contactId, contactIds)),
    tx
      .select({ contactId: contactListMembers.contactId, listId: contactListMembers.listId })
      .from(contactListMembers)
      .where(inArray(contactListMembers.contactId, contactIds)),
  ]);
  for (const r of tagRows) tagIds.set(r.contactId, [...(tagIds.get(r.contactId) ?? []), r.tagId]);
  for (const r of listRows) listIds.set(r.contactId, [...(listIds.get(r.contactId) ?? []), r.listId]);
  return { tagIds, listIds };
}

async function loadContact(tx: Transaction, ctx: ServiceCtx, id: string, now: Date): Promise<Contact | null> {
  const [row] = await tx
    .select({ contact: contacts, consent: consents })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, id)))
    .limit(1);
  if (!row) return null;
  const rel = await relationsFor(tx, [id]);
  return contactToDto(row.contact, { tagIds: rel.tagIds.get(id) ?? [], listIds: rel.listIds.get(id) ?? [], consent: consentToDto(row.consent, now) });
}

export async function recordContactEvent(
  tx: Transaction,
  organizationId: string,
  contactId: string,
  kind: EventKind,
  title: string,
  detail: string | null = null,
) {
  await tx.insert(contactEvents).values({ id: newId(), organizationId, contactId, kind, title, detail });
}

async function isOrgMember(tx: Transaction, organizationId: string, userId: string) {
  // `member` é do Better Auth e fica fora do RLS: o filtro por empresa é explícito.
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/** Pessoas da equipe que podem ser responsáveis (contatos e agenda). */
export async function listOrgOwners(tx: Transaction, organizationId: string): Promise<{ id: string; name: string }[]> {
  const rows = await tx
    .select({ id: user.id, name: user.name })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, organizationId));
  return rows.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

// Contatos ---------------------------------------------------------------------------------------------------

/**
 * Condição SQL da busca (filtros + lista/segmento) já restrita à empresa. `null` = a lista pedida não existe
 * (resultado vazio). Usada pela tabela e pela exportação.
 */
export async function contactsWhere(
  tx: Transaction,
  ctx: ServiceCtx,
  query: ContactFilter & { listId?: string | undefined },
  now: Date,
): Promise<SQL | null> {
  let listCondition: SQL | undefined;
  if (query.listId) {
    const [list] = await tx.select().from(contactLists).where(eq(contactLists.id, query.listId)).limit(1);
    if (!list) return null;
    listCondition = buildListCondition(list, now);
  }
  return and(eq(contacts.organizationId, ctx.organizationId), buildContactCondition(query, now), listCondition) ?? eq(contacts.organizationId, ctx.organizationId);
}

export async function listContacts(tx: Transaction, ctx: ServiceCtx, query: ContactListQuery, now = new Date()): Promise<ContactPage> {
  const overall = await Promise.all([
    tx.select({ n: count() }).from(contacts).where(eq(contacts.organizationId, ctx.organizationId)),
    tx
      .select({ n: count() })
      .from(consents)
      .where(and(eq(consents.organizationId, ctx.organizationId), eq(consents.status, "granted"))),
  ]);
  const overallTotals = { contacts: overall[0][0]?.n ?? 0, granted: overall[1][0]?.n ?? 0 };

  const where = await contactsWhere(tx, ctx, query, now);
  if (!where) return { items: [], total: 0, page: 1, pageSize: query.pageSize, overall: overallTotals };

  const [totalRow] = await tx.select({ n: count() }).from(contacts).where(where);
  const total = totalRow?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pages);

  const rows = await tx
    .select({ contact: contacts, consent: consents })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(where)
    .orderBy(desc(contacts.createdAt), asc(contacts.name), asc(contacts.id))
    .limit(query.pageSize)
    .offset((page - 1) * query.pageSize);
  const rel = await relationsFor(
    tx,
    rows.map((r) => r.contact.id),
  );
  return {
    items: rows.map((r) =>
      contactToDto(r.contact, {
        tagIds: rel.tagIds.get(r.contact.id) ?? [],
        listIds: rel.listIds.get(r.contact.id) ?? [],
        consent: consentToDto(r.consent, now),
      }),
    ),
    total,
    page,
    pageSize: query.pageSize,
    overall: overallTotals,
  };
}

export async function getContact(tx: Transaction, ctx: ServiceCtx, id: string, now = new Date()): Promise<ContactDetail | null> {
  const contact = await loadContact(tx, ctx, id, now);
  if (!contact) return null;
  const [notes, history, owner] = await Promise.all([
    tx.select().from(contactNotes).where(eq(contactNotes.contactId, id)).orderBy(desc(contactNotes.createdAt)).limit(200),
    tx.select().from(contactEvents).where(eq(contactEvents.contactId, id)).orderBy(desc(contactEvents.createdAt)).limit(200),
    contact.ownerId ? tx.select({ name: user.name }).from(user).where(eq(user.id, contact.ownerId)).limit(1) : Promise.resolve([]),
  ]);
  return {
    ...contact,
    notes: notes.map((n) => ({ id: n.id, text: n.text, authorName: n.authorName, createdAt: n.createdAt.toISOString() })),
    history: history.map((e) => ({
      id: e.id,
      kind: contactEventSchema.shape.kind.catch("created").parse(e.kind),
      title: e.title,
      detail: e.detail,
      at: e.createdAt.toISOString(),
    })),
    ownerName: owner[0]?.name ?? null,
  };
}

/** Opções enxutas para seletores (ex.: cliente no agendamento). */
export async function listContactOptions(tx: Transaction, ctx: ServiceCtx, limit = 5000) {
  return tx
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.organizationId, ctx.organizationId))
    .orderBy(asc(contacts.name), asc(contacts.id))
    .limit(limit);
}

async function validateTagIds(tx: Transaction, tagIds: string[]) {
  if (tagIds.length === 0) return true;
  const unique = [...new Set(tagIds)];
  const found = await tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, unique));
  return found.length === unique.length;
}

async function phoneOwner(tx: Transaction, ctx: ServiceCtx, phone: string, exceptId?: string) {
  const [row] = await tx
    .select({ id: contacts.id, name: contacts.name })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.phone, phone)))
    .limit(1);
  return row && row.id !== exceptId ? row : undefined;
}

type ResolvedInput = { phone: string | null; instagram: string | null };

function resolveInput(input: ContactInputData): Result<ResolvedInput, "invalid"> {
  let phone: string | null = null;
  if (input.phone) {
    const normalized = normalizePhone(input.phone);
    if (!normalized.ok) return fail("invalid", "Telefone inválido. Use DDD + número, ex.: 67 99812-3456.");
    phone = normalized.phone;
  }
  return ok({ phone, instagram: input.instagram.replace(/^@/, "") || null });
}

export async function createContact(
  tx: Transaction,
  ctx: ServiceCtx,
  input: ContactInputData,
  now = new Date(),
): Promise<Result<Contact, "duplicate" | "invalid">> {
  const resolved = resolveInput(input);
  if (!resolved.ok) return resolved;
  const { phone, instagram } = resolved.data;
  if (phone) {
    const clash = await phoneOwner(tx, ctx, phone);
    if (clash) return fail("duplicate", `Já existe um cliente com este telefone: ${clash.name}.`);
  }
  if (!(await validateTagIds(tx, input.tagIds))) return fail("invalid", "Etiqueta não encontrada.");
  if (input.ownerId && !(await isOrgMember(tx, ctx.organizationId, input.ownerId))) return fail("invalid", "Responsável não encontrado.");

  const id = newId();
  try {
    // savepoint: uma violação de unicidade (corrida) não derruba a transação inteira
    await tx.transaction(async (sp) => {
      await sp.insert(contacts).values({
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        phone,
        email: input.email || null,
        instagram,
        isCustomer: input.isCustomer,
        origin: input.origin,
        originNote: input.originNote || null,
        ownerId: input.ownerId,
        birthDate: input.birthDate || null,
      });
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return fail("duplicate", "Já existe um cliente com este telefone.");
    throw error;
  }
  const uniqueTags = [...new Set(input.tagIds)];
  if (uniqueTags.length) {
    await tx.insert(contactTags).values(uniqueTags.map((tagId) => ({ organizationId: ctx.organizationId, contactId: id, tagId })));
  }
  await recordContactEvent(tx, ctx.organizationId, id, "created", "Cadastro criado", `Criado por ${ctx.userName}`);
  const created = await loadContact(tx, ctx, id, now);
  if (!created) throw new Error("contato criado não encontrado");
  return ok(created);
}

export async function updateContact(
  tx: Transaction,
  ctx: ServiceCtx,
  id: string,
  input: ContactInputData,
  now = new Date(),
): Promise<Result<Contact, "not_found" | "duplicate" | "invalid">> {
  const [existing] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, id)))
    .limit(1);
  if (!existing) return fail("not_found", "Cliente não encontrado.");
  const resolved = resolveInput(input);
  if (!resolved.ok) return resolved;
  const { phone, instagram } = resolved.data;
  if (phone) {
    const clash = await phoneOwner(tx, ctx, phone, id);
    if (clash) return fail("duplicate", `Já existe um cliente com este telefone: ${clash.name}.`);
  }
  if (!(await validateTagIds(tx, input.tagIds))) return fail("invalid", "Etiqueta não encontrada.");
  if (input.ownerId && !(await isOrgMember(tx, ctx.organizationId, input.ownerId))) return fail("invalid", "Responsável não encontrado.");

  try {
    await tx.transaction(async (sp) => {
      await sp
        .update(contacts)
        .set({
          name: input.name,
          phone,
          email: input.email || null,
          instagram,
          isCustomer: input.isCustomer,
          origin: input.origin,
          originNote: input.originNote || null,
          ownerId: input.ownerId,
          birthDate: input.birthDate || null,
          updatedAt: now,
        })
        .where(and(eq(contacts.organizationId, ctx.organizationId), eq(contacts.id, id)));
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return fail("duplicate", "Já existe um cliente com este telefone.");
    throw error;
  }

  // etiquetas = conjunto exato enviado pelo formulário
  const wanted = new Set(input.tagIds);
  const current = await tx.select({ tagId: contactTags.tagId }).from(contactTags).where(eq(contactTags.contactId, id));
  const have = new Set(current.map((r) => r.tagId));
  const toRemove = [...have].filter((t) => !wanted.has(t));
  const toAdd = [...wanted].filter((t) => !have.has(t));
  if (toRemove.length) await tx.delete(contactTags).where(and(eq(contactTags.contactId, id), inArray(contactTags.tagId, toRemove)));
  if (toAdd.length) {
    await tx.insert(contactTags).values(toAdd.map((tagId) => ({ organizationId: ctx.organizationId, contactId: id, tagId })));
    const names = await tx.select({ name: tags.name }).from(tags).where(inArray(tags.id, toAdd));
    for (const t of names) await recordContactEvent(tx, ctx.organizationId, id, "tag", `Recebeu a etiqueta ${t.name}`);
  }
  const updated = await loadContact(tx, ctx, id, now);
  if (!updated) throw new Error("contato atualizado não encontrado");
  return ok(updated);
}

export async function addContactNote(
  tx: Transaction,
  ctx: ServiceCtx,
  contactId: string,
  text: string,
): Promise<Result<ContactNote, "not_found">> {
  const [existing] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!existing) return fail("not_found", "Cliente não encontrado.");
  const note = { id: newId(), organizationId: ctx.organizationId, contactId, authorId: ctx.userId, authorName: ctx.userName, text };
  const [row] = await tx.insert(contactNotes).values(note).returning();
  if (!row) throw new Error("nota não gravada");
  return ok({ id: row.id, text: row.text, authorName: row.authorName, createdAt: row.createdAt.toISOString() });
}

export async function tagContacts(
  tx: Transaction,
  ctx: ServiceCtx,
  contactIds: string[],
  tagId: string,
): Promise<Result<{ updated: number }, "not_found">> {
  const [tag] = await tx.select().from(tags).where(eq(tags.id, tagId)).limit(1);
  if (!tag) return fail("not_found", "Etiqueta não encontrada.");
  const existing = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, [...new Set(contactIds)])));
  if (existing.length === 0) return ok({ updated: 0 });
  const inserted = await tx
    .insert(contactTags)
    .values(existing.map((c) => ({ organizationId: ctx.organizationId, contactId: c.id, tagId })))
    .onConflictDoNothing()
    .returning({ contactId: contactTags.contactId });
  if (inserted.length) {
    await tx.insert(contactEvents).values(
      inserted.map((r) => ({
        id: newId(),
        organizationId: ctx.organizationId,
        contactId: r.contactId,
        kind: "tag",
        title: `Recebeu a etiqueta ${tag.name}`,
      })),
    );
  }
  return ok({ updated: inserted.length });
}

export async function addContactsToList(
  tx: Transaction,
  ctx: ServiceCtx,
  contactIds: string[],
  listId: string,
): Promise<Result<{ added: number }, "not_found" | "segment">> {
  const [list] = await tx.select().from(contactLists).where(eq(contactLists.id, listId)).limit(1);
  if (!list) return fail("not_found", "Lista não encontrada.");
  if (list.kind === "segment") return fail("segment", "Segmentos se atualizam sozinhos pelo filtro; não dá para adicionar pessoas.");
  const existing = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, [...new Set(contactIds)])));
  if (existing.length === 0) return ok({ added: 0 });
  const inserted = await tx
    .insert(contactListMembers)
    .values(existing.map((c) => ({ organizationId: ctx.organizationId, listId, contactId: c.id })))
    .onConflictDoNothing()
    .returning({ contactId: contactListMembers.contactId });
  return ok({ added: inserted.length });
}

// Exclusão do titular (LGPD §5.5) ---------------------------------------------------------------------------

type ErasureHook = (tx: Transaction, organizationId: string, contactIds: string[]) => Promise<void>;
const erasureHooks: ErasureHook[] = [];

/**
 * Outros módulos (Conversas, Campanhas) registram aqui a limpeza dos dados do titular que guardam
 * (mensagens, destinatários). Rodam na mesma transação, antes da exclusão do contato.
 */
export function registerContactErasureHook(hook: ErasureHook) {
  erasureHooks.push(hook);
}

/**
 * Remove o contato e, em cascata no banco, etiquetas, listas, notas, histórico, consentimentos e
 * agendamentos. Não deixa rastro de dado pessoal em log (só a contagem).
 */
export async function deleteContacts(tx: Transaction, ctx: ServiceCtx, contactIds: string[]): Promise<Result<{ deleted: number }>> {
  const found = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, [...new Set(contactIds)])));
  const ids = found.map((r) => r.id);
  if (ids.length === 0) return ok({ deleted: 0 });
  for (const hook of erasureHooks) await hook(tx, ctx.organizationId, ids);
  const deleted = await tx
    .delete(contacts)
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, ids)))
    .returning({ id: contacts.id });
  console.info({ event: "contacts_erased", organizationId: ctx.organizationId, userId: ctx.userId, count: deleted.length });
  return ok({ deleted: deleted.length });
}

// Etiquetas -------------------------------------------------------------------------------------------------

const DEFAULT_TAGS: { name: string; description: string; color: TagInput["color"] }[] = [
  { name: "Novos", description: "Chegou agora, ainda sem contexto", color: "ink" },
  { name: "Em conversa", description: "Tirando dúvidas ou negociando", color: "duck" },
  { name: "Proposta", description: "Recebeu orçamento, aguardando resposta", color: "slate" },
  { name: "Fechados", description: "Atendimento concluído", color: "ok" },
];

/** Empresa sem etiquetas ganha as 4 etapas do funil (idempotente, seguro sob concorrência). */
export async function ensureDefaultTags(tx: Transaction, organizationId: string) {
  const [row] = await tx.select({ n: count() }).from(tags).where(eq(tags.organizationId, organizationId));
  if ((row?.n ?? 0) > 0) return;
  await tx
    .insert(tags)
    .values(DEFAULT_TAGS.map((t, position) => ({ id: newId(), organizationId, ...t, position, funnelStage: position + 1 })))
    .onConflictDoNothing();
}

const funnelStageFor = (position: number) => (position < FUNNEL_STAGE_COUNT ? position + 1 : null);

function tagToDto(row: typeof tags.$inferSelect, contactCount: number): Tag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: tagColorSchema.catch("ink").parse(row.color),
    position: row.position,
    contactCount,
  };
}

export async function listTags(tx: Transaction, ctx: ServiceCtx): Promise<Tag[]> {
  await ensureDefaultTags(tx, ctx.organizationId);
  const rows = await tx
    .select({ tag: tags, n: count(contactTags.contactId) })
    .from(tags)
    .leftJoin(contactTags, eq(contactTags.tagId, tags.id))
    .where(eq(tags.organizationId, ctx.organizationId))
    .groupBy(tags.id)
    .orderBy(asc(tags.position));
  return rows.map((r) => tagToDto(r.tag, r.n));
}

async function tagNameTaken(tx: Transaction, ctx: ServiceCtx, name: string, exceptId?: string) {
  const all = await tx.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.organizationId, ctx.organizationId));
  return all.some((t) => t.id !== exceptId && normalizeText(t.name) === normalizeText(name));
}

export async function createTag(tx: Transaction, ctx: ServiceCtx, input: TagInput): Promise<Result<Tag, "duplicate">> {
  await ensureDefaultTags(tx, ctx.organizationId);
  if (await tagNameTaken(tx, ctx, input.name)) return fail("duplicate", "Já existe uma etiqueta com esse nome.");
  const [top] = await tx.select({ top: max(tags.position) }).from(tags).where(eq(tags.organizationId, ctx.organizationId));
  const position = (top?.top ?? -1) + 1;
  const [row] = await tx
    .insert(tags)
    .values({ id: newId(), organizationId: ctx.organizationId, ...input, position, funnelStage: funnelStageFor(position) })
    .returning();
  if (!row) throw new Error("etiqueta não gravada");
  return ok(tagToDto(row, 0));
}

export async function updateTag(tx: Transaction, ctx: ServiceCtx, id: string, input: TagInput): Promise<Result<Tag, "not_found" | "duplicate">> {
  const [current] = await tx.select().from(tags).where(and(eq(tags.organizationId, ctx.organizationId), eq(tags.id, id))).limit(1);
  if (!current) return fail("not_found", "Etiqueta não encontrada.");
  if (await tagNameTaken(tx, ctx, input.name, id)) return fail("duplicate", "Já existe uma etiqueta com esse nome.");
  const [row] = await tx.update(tags).set(input).where(eq(tags.id, id)).returning();
  if (!row) throw new Error("etiqueta não atualizada");
  const [n] = await tx.select({ n: count() }).from(contactTags).where(eq(contactTags.tagId, id));
  return ok(tagToDto(row, n?.n ?? 0));
}

async function renumber(tx: Transaction, orderedIds: string[]) {
  for (const [position, id] of orderedIds.entries()) {
    await tx.update(tags).set({ position, funnelStage: funnelStageFor(position) }).where(eq(tags.id, id));
  }
}

/** Recebe a nova ordem completa. As 4 primeiras viram as etapas do funil. */
export async function reorderTags(tx: Transaction, ctx: ServiceCtx, orderedIds: string[]): Promise<Result<null, "invalid">> {
  const current = await tx.select({ id: tags.id }).from(tags).where(eq(tags.organizationId, ctx.organizationId));
  const wanted = new Set(orderedIds);
  if (orderedIds.length !== current.length || wanted.size !== orderedIds.length || !current.every((t) => wanted.has(t.id))) {
    return fail("invalid", "A ordem enviada não confere com as etiquetas atuais.");
  }
  await renumber(tx, orderedIds);
  return ok(null);
}

export async function deleteTag(tx: Transaction, ctx: ServiceCtx, id: string): Promise<Result<null, "not_found" | "funnel_stage">> {
  const ordered = await tx.select().from(tags).where(eq(tags.organizationId, ctx.organizationId)).orderBy(asc(tags.position));
  const index = ordered.findIndex((t) => t.id === id);
  if (index < 0) return fail("not_found", "Etiqueta não encontrada.");
  if (index < FUNNEL_STAGE_COUNT) {
    return fail("funnel_stage", "Esta etiqueta é uma etapa do funil. Mova outra etiqueta para cima antes de excluir.");
  }
  await tx.delete(tags).where(eq(tags.id, id));
  await renumber(
    tx,
    ordered.filter((t) => t.id !== id).map((t) => t.id),
  );
  return ok(null);
}

// Listas e segmentos ------------------------------------------------------------------------------------------

async function memberCounts(tx: Transaction, rows: (typeof contactLists.$inferSelect)[], now: Date) {
  const counts = new Map<string, number>();
  const staticIds = rows.filter((l) => l.kind === "static").map((l) => l.id);
  if (staticIds.length) {
    const grouped = await tx
      .select({ listId: contactListMembers.listId, n: count() })
      .from(contactListMembers)
      .where(inArray(contactListMembers.listId, staticIds))
      .groupBy(contactListMembers.listId);
    for (const g of grouped) counts.set(g.listId, g.n);
  }
  // segmentos: contagem ao vivo, avaliando o filtro salvo em SQL
  for (const list of rows.filter((l) => l.kind === "segment")) {
    const [row] = await tx
      .select({ n: count() })
      .from(contacts)
      .where(and(eq(contacts.organizationId, list.organizationId), buildContactCondition(parseFilter(list.filter), now)));
    counts.set(list.id, row?.n ?? 0);
  }
  return counts;
}

function listToDto(row: typeof contactLists.$inferSelect, memberCount: number): ContactList {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === "segment" ? "segment" : "static",
    description: row.description,
    filter: row.kind === "segment" ? parseFilter(row.filter) : null,
    memberCount,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listContactLists(tx: Transaction, ctx: ServiceCtx, now = new Date()): Promise<ContactList[]> {
  const rows = await tx.select().from(contactLists).where(eq(contactLists.organizationId, ctx.organizationId)).orderBy(desc(contactLists.createdAt));
  const counts = await memberCounts(tx, rows, now);
  return rows.map((r) => listToDto(r, counts.get(r.id) ?? 0));
}

export async function createContactList(
  tx: Transaction,
  ctx: ServiceCtx,
  input: ContactListInput,
  now = new Date(),
): Promise<Result<ContactList, "duplicate">> {
  const all = await tx.select({ name: contactLists.name }).from(contactLists).where(eq(contactLists.organizationId, ctx.organizationId));
  if (all.some((l) => normalizeText(l.name) === normalizeText(input.name))) return fail("duplicate", "Já existe uma lista com esse nome.");
  // o filtro salvo é sempre o objeto já validado pelo schema do contrato (Zod), nunca texto livre
  const filter = input.kind === "segment" ? parseFilter(input.filter ?? {}) : null;
  const [row] = await tx
    .insert(contactLists)
    .values({ id: newId(), organizationId: ctx.organizationId, name: input.name, description: input.description, kind: input.kind, filter })
    .returning();
  if (!row) throw new Error("lista não gravada");
  const counts = await memberCounts(tx, [row], now);
  return ok(listToDto(row, counts.get(row.id) ?? 0));
}

export async function deleteContactList(tx: Transaction, ctx: ServiceCtx, id: string): Promise<Result<null, "not_found">> {
  const deleted = await tx
    .delete(contactLists)
    .where(and(eq(contactLists.organizationId, ctx.organizationId), eq(contactLists.id, id)))
    .returning({ id: contactLists.id });
  return deleted.length ? ok(null) : fail("not_found", "Lista não encontrada.");
}

// Consentimento (respostas, opt-out, expiração) — chamados por Conversas/Campanhas/worker ------------------------

export type ConsentReplyOutcome = { handled: boolean; intent: ReplyIntent | null; status: ConsentStatus | null; changed: boolean };

/**
 * Resposta do contato ao convite. Só interpreta quem tem convite (linha em `consents`). Recusa é permanente;
 * ambiguidade não aceita nada (vira conversa normal para o agente). Grava a resposta como prova.
 */
export async function registerConsentReply(
  tx: Transaction,
  organizationId: string,
  contactId: string,
  replyText: string,
  now = new Date(),
): Promise<ConsentReplyOutcome> {
  const [row] = await tx
    .select()
    .from(consents)
    .where(and(eq(consents.organizationId, organizationId), eq(consents.contactId, contactId)))
    .limit(1);
  if (!row) return { handled: false, intent: null, status: null, changed: false };
  const current = effectiveConsentStatus(row, now);
  const intent = interpretConsentReply(replyText);
  const next = nextConsentStatus(current, intent);
  if (next === current && row.status === current) return { handled: true, intent, status: current, changed: false };
  await tx
    .update(consents)
    .set({ status: next, replyText, repliedAt: now, updatedAt: now })
    .where(eq(consents.id, row.id));
  await recordContactEvent(
    tx,
    organizationId,
    contactId,
    "consent",
    next === "granted" ? "Aceitou receber mensagens" : "Recusou receber mensagens",
    "Resposta registrada como prova",
  );
  return { handled: true, intent, status: next, changed: true };
}

/** Saída explícita (SAIR/PARAR…) em qualquer conversa: bloqueia para sempre, com ou sem convite anterior. */
export async function registerOptOut(tx: Transaction, organizationId: string, contactId: string, replyText: string, now = new Date()) {
  const [row] = await tx
    .select()
    .from(consents)
    .where(and(eq(consents.organizationId, organizationId), eq(consents.contactId, contactId)))
    .limit(1);
  if (row?.status === "denied") return;
  if (row) {
    await tx.update(consents).set({ status: "denied", replyText, repliedAt: now, updatedAt: now }).where(eq(consents.id, row.id));
  } else {
    await tx.insert(consents).values({
      id: newId(),
      organizationId,
      contactId,
      status: "denied",
      method: "conversation",
      replyText,
      repliedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
  await recordContactEvent(tx, organizationId, contactId, "consent", "Pediu para não receber mensagens", "Bloqueio permanente");
}

/** O worker confirma que o provedor aceitou o convite: começa a contar os 7 dias. */
export async function markInviteSent(tx: Transaction, organizationId: string, contactId: string, at = new Date()) {
  await tx
    .update(consents)
    .set({ inviteSentAt: at, updatedAt: at })
    .where(and(eq(consents.organizationId, organizationId), eq(consents.contactId, contactId), eq(consents.status, "pending")));
}

/** Job diário: `pending` sem resposta há mais de 7 dias vira `expired`. */
export async function expireStaleInvites(tx: Transaction, organizationId: string, now = new Date()) {
  const expired = await tx
    .update(consents)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(consents.organizationId, organizationId),
        eq(consents.status, "pending"),
        sql`${consents.inviteSentAt} < ${inviteCutoff(now).toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: consents.id });
  return expired.length;
}

// API para o módulo Conversas -----------------------------------------------------------------------------

export type ContactRef = { id: string; name: string; phone: string | null };

export async function findContactByPhone(tx: Transaction, organizationId: string, phone: string): Promise<ContactRef | null> {
  const normalized = normalizePhone(phone);
  if (!normalized.ok) return null;
  const [row] = await tx
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.phone, normalized.phone)))
    .limit(1);
  return row ?? null;
}

/**
 * Acha ou cria o contato do telefone (mensagem recebida, agendamento do agente…). `source` vira a origem se for
 * uma origem conhecida (ex.: "inbound": quem escreve primeiro não recebe convite). Seguro sob concorrência.
 */
export async function upsertContactByPhone(
  tx: Transaction,
  organizationId: string,
  input: { phone: string; name?: string | null; source?: string | null },
): Promise<{ contact: ContactRef; created: boolean } | null> {
  const normalized = normalizePhone(input.phone);
  if (!normalized.ok) return null;
  const origin = contactOriginSchema.safeParse(input.source);
  const name = input.name?.trim() || normalized.phone;
  const [inserted] = await tx
    .insert(contacts)
    .values({
      id: newId(),
      organizationId,
      name: name.slice(0, 120),
      phone: normalized.phone,
      origin: origin.success ? origin.data : null,
    })
    .onConflictDoNothing({ target: [contacts.organizationId, contacts.phone] })
    .returning({ id: contacts.id, name: contacts.name, phone: contacts.phone });
  if (inserted) {
    await recordContactEvent(tx, organizationId, inserted.id, "created", "Cadastro criado", input.source ? `Origem: ${input.source}` : null);
    return { contact: inserted, created: true };
  }
  const existing = await findContactByPhone(tx, organizationId, normalized.phone);
  return existing ? { contact: existing, created: false } : null;
}

/** Conversas chama a cada mensagem para alimentar o filtro "sem interação há N dias". */
export async function touchContactInteraction(tx: Transaction, organizationId: string, contactId: string, at = new Date()) {
  await tx
    .update(contacts)
    .set({ lastInteractionAt: at })
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)));
}
