import {
  type ExportRequest,
  type ImportCommit,
  type ImportField,
  type ImportPreview,
  type ImportResult,
} from "@duckzap/contracts/contacts";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { zonedDay } from "../appointments/time";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, buildCsv, buildImportSheet, cleanEmail, parseBirthDate } from "./csv";
import { effectiveConsentStatus } from "./consent";
import { normalizePhone } from "./phone";
import { chunk, fail, newId, ok, type Result, type ServiceCtx } from "./result";
import { contactsWhere } from "./service";

const { contacts, tags, contactTags, contactListMembers, contactLists, contactEvents, contactImports, consents } = schema;

const IMPORT_TTL_MS = 60 * 60 * 1000;
const EXPORT_LIMIT = 50_000;

// Importação ---------------------------------------------------------------------------------------------------

export type ImportFile = { name: string; size: number; text: string };

/**
 * Etapa 1: lê o CSV no servidor, devolve colunas (com sugestão de mapeamento) e amostra, e guarda as linhas até a
 * confirmação. XLSX não é aceito nesta fase (nenhuma biblioteca de planilha instalada): peça para salvar como CSV.
 */
export async function previewImport(
  tx: Transaction,
  ctx: ServiceCtx,
  file: ImportFile,
  now = new Date(),
): Promise<Result<ImportPreview, "empty" | "too_large" | "unsupported_format">> {
  if (file.size === 0 || file.text.trim() === "") return fail("empty", "O arquivo está vazio.");
  if (file.size > MAX_IMPORT_BYTES) return fail("too_large", "O arquivo passa de 10 MB. Divida em partes menores.");
  if (!/\.(csv|txt)$/i.test(file.name)) {
    return fail(
      "unsupported_format",
      "Por enquanto só importamos CSV. No Excel, use Salvar como > CSV (separado por vírgulas ou por ponto e vírgula) e envie de novo.",
    );
  }
  const sheet = buildImportSheet(file.text);
  if (sheet.columns.length === 0 || sheet.rows.length === 0) return fail("empty", "Não encontramos linhas de contatos no arquivo.");
  if (sheet.rows.length > MAX_IMPORT_ROWS) {
    return fail("too_large", `O arquivo tem mais de ${MAX_IMPORT_ROWS.toLocaleString("pt-BR")} linhas. Divida em partes menores.`);
  }

  await tx.delete(contactImports).where(and(eq(contactImports.organizationId, ctx.organizationId), lt(contactImports.expiresAt, now)));
  const importId = newId();
  await tx.insert(contactImports).values({
    id: importId,
    organizationId: ctx.organizationId,
    fileName: file.name.slice(0, 200),
    rows: sheet.rows,
    createdBy: ctx.userId,
    expiresAt: new Date(now.getTime() + IMPORT_TTL_MS),
  });
  return ok({ importId, fileName: file.name, columns: sheet.columns, sampleRows: sheet.rows.slice(0, 5), totalRows: sheet.rows.length });
}

export type ImportCandidate = { row: number; name: string; phone: string; email: string | null; birthDate: string | null; note: string | null };

export type PendingImport = typeof contactImports.$inferSelect;

/** Importação guardada na prévia e ainda válida (da empresa do tx); expirada ou inexistente é `not_found`. */
export async function loadPendingImport(tx: Transaction, ctx: ServiceCtx, importId: string, now: Date): Promise<Result<PendingImport, "not_found">> {
  const [pending] = await tx
    .select()
    .from(contactImports)
    .where(and(eq(contactImports.organizationId, ctx.organizationId), eq(contactImports.id, importId)))
    .limit(1);
  if (!pending || pending.expiresAt < now) return fail("not_found", "A importação expirou. Comece de novo.");
  return ok(pending);
}

/** Etiquetas e lista escolhidas existem (o RLS limita à empresa); a lista precisa ser estática. Devolve as etiquetas sem repetição. */
export async function checkImportTargets(tx: Transaction, tagIdList: readonly string[], listId: string | null): Promise<Result<string[], "invalid">> {
  const tagIds = [...new Set(tagIdList)];
  if (tagIds.length) {
    const found = await tx.select({ id: tags.id }).from(tags).where(inArray(tags.id, tagIds));
    if (found.length !== tagIds.length) return fail("invalid", "Etiqueta não encontrada.");
  }
  if (listId) {
    const [list] = await tx.select().from(contactLists).where(eq(contactLists.id, listId)).limit(1);
    if (!list || list.kind !== "static") return fail("invalid", "Escolha uma lista estática existente.");
  }
  return ok(tagIds);
}

/** Consome a importação (uso único); false se outra requisição chegou antes. */
export async function claimPendingImport(tx: Transaction, ctx: ServiceCtx, importId: string): Promise<boolean> {
  const claimed = await tx
    .delete(contactImports)
    .where(and(eq(contactImports.organizationId, ctx.organizationId), eq(contactImports.id, importId)))
    .returning({ id: contactImports.id });
  return claimed.length > 0;
}

/**
 * Etapa 2: aplica o mapeamento. Deduplica por telefone (no arquivo e na base): quem já existe é atualizado
 * (etiquetas, lista e campos vazios), nunca duplicado. Origem e a confirmação de relação são obrigatórias
 * (a rota valida `confirmedRelationship: true` com Zod; o service exige a origem declarada).
 */
export async function commitImport(
  tx: Transaction,
  ctx: ServiceCtx,
  commit: ImportCommit,
  now = new Date(),
): Promise<Result<ImportResult, "not_found" | "no_name" | "no_phone" | "invalid">> {
  const loaded = await loadPendingImport(tx, ctx, commit.importId, now);
  if (!loaded.ok) return fail("not_found", "A importação expirou. Envie o arquivo de novo.");
  const pending = loaded.data;

  const columnFor = (field: ImportField) => Object.entries(commit.mapping).find(([, f]) => f === field)?.[0];
  const nameCol = columnFor("name");
  const phoneCol = columnFor("phone");
  if (!nameCol) return fail("no_name", "Escolha a coluna do nome.");
  if (!phoneCol) return fail("no_phone", "Escolha a coluna do telefone.");
  const emailCol = columnFor("email");
  const birthCol = columnFor("birthDate");
  const noteCol = columnFor("note");

  const targets = await checkImportTargets(tx, commit.tagIds, commit.listId);
  if (!targets.ok) return targets;
  if (!(await claimPendingImport(tx, ctx, commit.importId))) return fail("not_found", "A importação expirou. Envie o arquivo de novo.");

  const result: ImportResult = { created: 0, updated: 0, skipped: [] };
  const candidates: ImportCandidate[] = [];
  const seen = new Set<string>();
  pending.rows.forEach((row, index) => {
    const rowNumber = index + 2; // a linha 1 é o cabeçalho
    const phone = normalizePhone(row[phoneCol] ?? "");
    if (!phone.ok) return void result.skipped.push({ row: rowNumber, reason: phone.reason });
    if (seen.has(phone.phone)) return void result.skipped.push({ row: rowNumber, reason: "duplicate" });
    seen.add(phone.phone);
    candidates.push({
      row: rowNumber,
      name: (row[nameCol] ?? "").slice(0, 120) || "Sem nome",
      phone: phone.phone,
      email: emailCol ? cleanEmail(row[emailCol]) : null,
      birthDate: birthCol ? parseBirthDate(row[birthCol]) : null,
      note: noteCol ? (row[noteCol] ?? "").slice(0, 160) || null : null,
    });
  });

  const target = { origin: commit.origin, originNote: commit.originNote, tagIds: targets.data, listId: commit.listId, sourceName: pending.fileName };
  await applyImport(tx, ctx, target, candidates, result, now);
  return ok(result);
}

export type ImportTarget = Pick<ImportCommit, "origin" | "originNote" | "listId"> & {
  tagIds: readonly string[];
  /** Vira o título do evento "Importado de …" na linha do tempo de cada cliente criado. */
  sourceName: string;
};

/**
 * Miolo comum da planilha e do WhatsApp: recebe candidatos já normalizados e sem repetição. Quem já existe é atualizado,
 * quem é novo é criado (corrida resolvida por `onConflictDoNothing`), etiquetas e lista valem para todos e os novos ganham
 * o evento "Importado de …". Acumula em `result`.
 */
export async function applyImport(
  tx: Transaction,
  ctx: ServiceCtx,
  target: ImportTarget,
  candidates: readonly ImportCandidate[],
  result: ImportResult,
  now: Date,
): Promise<void> {
  const { tagIds, listId } = target;
  const touched: string[] = [];
  const createdIds: string[] = [];
  for (const batch of chunk(candidates, 1000)) {
    const existing = await tx
      .select({ id: contacts.id, phone: contacts.phone, email: contacts.email, birthDate: contacts.birthDate })
      .from(contacts)
      .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.phone, batch.map((c) => c.phone))));
    const byPhone = new Map(existing.map((e) => [e.phone, e]));
    const fresh: ImportCandidate[] = [];
    for (const candidate of batch) {
      const found = byPhone.get(candidate.phone);
      if (!found) {
        fresh.push(candidate);
        continue;
      }
      touched.push(found.id);
      result.updated++;
      const fill = {
        ...(!found.email && candidate.email ? { email: candidate.email } : {}),
        ...(!found.birthDate && candidate.birthDate ? { birthDate: candidate.birthDate } : {}),
      };
      if (Object.keys(fill).length) await tx.update(contacts).set({ ...fill, updatedAt: now }).where(eq(contacts.id, found.id));
    }
    if (fresh.length) {
      const inserted = await tx
        .insert(contacts)
        .values(
          fresh.map((c) => ({
            id: newId(),
            organizationId: ctx.organizationId,
            name: c.name,
            phone: c.phone,
            email: c.email,
            isCustomer: target.origin === "customer",
            origin: target.origin,
            originNote: target.originNote || c.note,
            birthDate: c.birthDate,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing({ target: [contacts.organizationId, contacts.phone] })
        .returning({ id: contacts.id, phone: contacts.phone });
      const insertedPhones = new Set(inserted.map((i) => i.phone));
      for (const c of fresh) if (!insertedPhones.has(c.phone)) result.skipped.push({ row: c.row, reason: "duplicate" });
      result.created += inserted.length;
      createdIds.push(...inserted.map((i) => i.id));
      touched.push(...inserted.map((i) => i.id));
    }
  }

  for (const batch of chunk(touched, 1000)) {
    if (tagIds.length) {
      await tx
        .insert(contactTags)
        .values(batch.flatMap((contactId) => tagIds.map((tagId) => ({ organizationId: ctx.organizationId, contactId, tagId }))))
        .onConflictDoNothing();
    }
    if (listId) {
      await tx
        .insert(contactListMembers)
        .values(batch.map((contactId) => ({ organizationId: ctx.organizationId, listId, contactId })))
        .onConflictDoNothing();
    }
  }
  for (const batch of chunk(createdIds, 1000)) {
    await tx.insert(contactEvents).values(
      batch.map((contactId) => ({
        id: newId(),
        organizationId: ctx.organizationId,
        contactId,
        kind: "import",
        title: `Importado de ${target.sourceName}`,
        detail: "Relação com a empresa confirmada na importação",
        createdAt: now,
      })),
    );
  }
  result.skipped.sort((a, b) => a.row - b.row);
}

// Exportação ---------------------------------------------------------------------------------------------------

const EXPORT_HEADER = ["Nome", "Telefone", "E-mail", "Instagram", "É cliente", "Etiquetas", "Disparos", "Origem", "Criado em"] as const;

/** CSV com `;` e BOM; células que começam com = + - @ ganham uma aspa na frente (injeção de fórmula). */
export async function exportContacts(
  tx: Transaction,
  ctx: ServiceCtx,
  request: ExportRequest,
  now = new Date(),
): Promise<{ fileName: string; csv: string; count: number }> {
  const today = zonedDay(now.toISOString(), ctx.timeZone);
  const fileName = `clientes-${today}.csv`;

  let where;
  if (request.contactIds) {
    const ids = [...new Set(request.contactIds)].slice(0, EXPORT_LIMIT);
    where = and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, ids));
  } else {
    const built = await contactsWhere(tx, ctx, { ...(request.filter ?? {}) }, now);
    if (!built) return { fileName, csv: buildCsv(EXPORT_HEADER, []), count: 0 };
    where = built;
  }
  const rows = await tx
    .select({ contact: contacts, consent: consents })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(where)
    .orderBy(desc(contacts.createdAt), asc(contacts.name), asc(contacts.id))
    .limit(EXPORT_LIMIT);

  const tagNames = new Map<string, string[]>();
  for (const batch of chunk(
    rows.map((r) => r.contact.id),
    2000,
  )) {
    const links = await tx
      .select({ contactId: contactTags.contactId, name: tags.name, position: tags.position })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(inArray(contactTags.contactId, batch))
      .orderBy(asc(tags.position));
    for (const l of links) tagNames.set(l.contactId, [...(tagNames.get(l.contactId) ?? []), l.name]);
  }

  const lines = rows.map(({ contact: c, consent }) => [
    c.name,
    c.phone ?? "",
    c.email ?? "",
    c.instagram ? `@${c.instagram}` : "",
    c.isCustomer ? "Sim" : "Não",
    (tagNames.get(c.id) ?? []).join(", "),
    consent ? effectiveConsentStatus(consent, now) : "sem convite",
    c.origin ?? "",
    zonedDay(c.createdAt.toISOString(), ctx.timeZone),
  ]);
  return { fileName, csv: buildCsv(EXPORT_HEADER, lines), count: rows.length };
}
