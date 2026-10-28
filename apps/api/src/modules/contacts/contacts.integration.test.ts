import { randomInt } from "node:crypto";
import { createDb, schema, withOrg, type Transaction } from "@duckzap/db";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, describe, expect, it } from "vitest";
import { exportContacts, commitImport, previewImport } from "./import-export";
import { getInviteOverview, inviteContacts } from "./invites";
import { createInMemoryPorts } from "./ports";
import * as service from "./service";
import type { ContactInputData } from "./service";
import type { ServiceCtx } from "./result";

// INTEGRAÇÃO — precisa do Postgres do Docker com a migration das tabelas de Clientes (contacts, tags, consents…)
// e o seed (org_alvorada, org_lume). Liga com CLIENTES_INTEGRATION=1 e DATABASE_URL (papel duckzap_app, sem BYPASSRLS).
// Cada teste roda numa transação desfeita no fim: nada fica no banco.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}
const enabled = process.env.CLIENTES_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const db = enabled ? createDb(process.env.DATABASE_URL as string, { max: 2 }) : null;
afterAll(async () => db?.close());

const A: ServiceCtx = { organizationId: "org_alvorada", userId: "usr_marina", userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "Casa Alvorada Odontologia" };
const B: ServiceCtx = { organizationId: "org_lume", userId: "usr_lume", userName: "Lia Moraes", timeZone: "America/Sao_Paulo", orgName: "Studio Lume" };

async function rollback(fn: (tx: Transaction) => Promise<void>) {
  const marker = new Error("rollback");
  try {
    await withOrg(db!.db, A.organizationId, async (tx) => {
      await fn(tx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

/** Canal REAL da empresa dentro da transação (`consents.channel_id` é FK uuid): o convite grava o id do canal. */
async function insertChannel(tx: Transaction, ctx: ServiceCtx, name: string) {
  const id = uuidv7();
  await tx.insert(schema.channels).values({
    id,
    organizationId: ctx.organizationId,
    name,
    type: "whatsapp_qr",
    provider: "evolution",
    status: "connected",
    webhookTokenHash: `hash-${id}`,
    webhookTokenEnc: `enc-${id}`,
  });
  return id;
}

/** Passa a falar como outra empresa dentro da mesma transação (o RLS reavalia `app.org_id`). */
const actAs = (tx: Transaction, ctx: ServiceCtx) => tx.execute(sql`select set_config('app.org_id', ${ctx.organizationId}, true)`);

const randomPhone = () => `+55679${String(randomInt(10_000_000, 99_999_999))}`;
const input = (overrides: Partial<ContactInputData> = {}): ContactInputData => ({
  name: "Cliente de Teste",
  phone: randomPhone(),
  email: "",
  instagram: "",
  isCustomer: false,
  tagIds: [],
  origin: "form",
  originNote: "",
  ownerId: null,
  birthDate: "",
  ...overrides,
});
const mustOk = <T>(r: { ok: true; data: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.data;
};
const query = { page: 1, pageSize: 25 } as const;

describe.skipIf(!enabled)("Clientes — casos de uso (precisa da migration)", () => {
  it("cria, lê, atualiza e rejeita telefone duplicado", async () => {
    await rollback(async (tx) => {
      const phone = randomPhone();
      const created = mustOk(await service.createContact(tx, A, input({ phone, name: "Ana Souza", email: "ana@exemplo.com" })));
      expect(created.phone).toBe(phone);
      expect(created.consent).toBeNull();

      const dup = await service.createContact(tx, A, input({ phone, name: "Outra Ana" }));
      expect(dup).toMatchObject({ ok: false, error: "duplicate" });

      const updated = mustOk(await service.updateContact(tx, A, created.id, input({ phone, name: "Ana S. Souza", isCustomer: true })));
      expect(updated.name).toBe("Ana S. Souza");
      expect(updated.isCustomer).toBe(true);

      const detail = await service.getContact(tx, A, created.id);
      expect(detail?.history.map((h) => h.kind)).toContain("created");
    });
  });

  it("outra empresa não lê, não altera e não apaga contatos de A (RLS + filtro explícito)", async () => {
    await rollback(async (tx) => {
      const created = mustOk(await service.createContact(tx, A, input({ name: "Só da Alvorada" })));
      const note = mustOk(await service.addContactNote(tx, A, created.id, "nota privada"));
      expect(note.authorName).toBe("Marina Alves");

      await actAs(tx, B);
      expect(await service.getContact(tx, B, created.id)).toBeNull();
      // B pode ter contatos próprios (outros testes rodam em paralelo): o que importa é não enxergar o de A
      const seenByB = await service.listContacts(tx, B, { ...query, q: "Só da Alvorada" });
      expect(seenByB.total).toBe(0);
      expect(seenByB.items.map((c) => c.id)).not.toContain(created.id);
      expect(await service.updateContact(tx, B, created.id, input())).toMatchObject({ ok: false, error: "not_found" });
      expect(await service.addContactNote(tx, B, created.id, "x")).toMatchObject({ ok: false, error: "not_found" });
      expect(mustOk(await service.deleteContacts(tx, B, [created.id])).deleted).toBe(0);

      await actAs(tx, A);
      expect(await service.getContact(tx, A, created.id)).not.toBeNull();
    });
  });

  it("busca e filtros (aba, q, etiqueta, cliente, consentimento, lista)", async () => {
    await rollback(async (tx) => {
      const tags = await service.listTags(tx, A);
      expect(tags.slice(0, 4).map((t) => t.name)).toEqual(["Novos", "Em conversa", "Proposta", "Fechados"]);
      const tag = tags[0];
      if (!tag) throw new Error("sem etiqueta");

      const maria = mustOk(await service.createContact(tx, A, input({ name: "Maria Zzfiltro", isCustomer: true, tagIds: [tag.id] })));
      mustOk(await service.createContact(tx, A, input({ name: "João Zzfiltro" })));

      expect((await service.listContacts(tx, A, { ...query, q: "zzfiltro" })).total).toBe(2);
      expect((await service.listContacts(tx, A, { ...query, q: "maria zzf" })).items.map((c) => c.id)).toEqual([maria.id]);
      expect((await service.listContacts(tx, A, { ...query, q: "zzfiltro", isCustomer: true })).total).toBe(1);
      expect((await service.listContacts(tx, A, { ...query, q: "zzfiltro", tagId: tag.id })).items[0]?.tagIds).toEqual([tag.id]);
      expect((await service.listContacts(tx, A, { ...query, q: "zzfiltro", consent: "none" })).total).toBe(2);
      expect((await service.listContacts(tx, A, { ...query, q: "zzfiltro", consent: "granted" })).total).toBe(0);

      const list = mustOk(await service.createContactList(tx, A, { name: "Lista de teste", description: "", kind: "static", filter: null }));
      expect(mustOk(await service.addContactsToList(tx, A, [maria.id], list.id)).added).toBe(1);
      expect(mustOk(await service.addContactsToList(tx, A, [maria.id], list.id)).added).toBe(0);
      const inList = await service.listContacts(tx, A, { ...query, listId: list.id });
      expect(inList.items.map((c) => c.id)).toEqual([maria.id]);
      expect(inList.items[0]?.listIds).toEqual([list.id]);
    });
  });

  it("segmento dinâmico: contagem ao vivo a partir do filtro salvo; lista estática não aceita filtro", async () => {
    await rollback(async (tx) => {
      const segment = mustOk(await service.createContactList(tx, A, { name: "Clientes teste", description: "", kind: "segment", filter: { isCustomer: true, q: "zzseg" } }));
      expect(segment.memberCount).toBe(0);
      mustOk(await service.createContact(tx, A, input({ name: "Zzseg Cliente", isCustomer: true })));
      mustOk(await service.createContact(tx, A, input({ name: "Zzseg Prospecto" })));
      const lists = await service.listContactLists(tx, A);
      expect(lists.find((l) => l.id === segment.id)?.memberCount).toBe(1);
      expect(await service.addContactsToList(tx, A, [], segment.id)).toMatchObject({ ok: false, error: "segment" });
    });
  });

  it("etiquetas: as 4 primeiras são o funil e não podem ser excluídas; reordenar muda o funil", async () => {
    await rollback(async (tx) => {
      const tags = await service.listTags(tx, A);
      const [first, , , fourth] = tags;
      if (!first || !fourth) throw new Error("funil incompleto");
      expect(await service.deleteTag(tx, A, first.id)).toMatchObject({ ok: false, error: "funnel_stage" });

      const extra = mustOk(await service.createTag(tx, A, { name: "Etiqueta extra", description: "", color: "warn" }));
      expect(extra.position).toBe(tags.length);
      expect(await service.createTag(tx, A, { name: "etiqueta EXTRA", description: "", color: "ok" })).toMatchObject({ ok: false, error: "duplicate" });

      const order = [extra.id, ...tags.map((t) => t.id)];
      mustOk(await service.reorderTags(tx, A, order));
      const reordered = await service.listTags(tx, A);
      expect(reordered[0]?.id).toBe(extra.id);
      const [row] = await tx.select().from(schema.tags).where(eq(schema.tags.id, extra.id));
      expect(row?.funnelStage).toBe(1);
      expect(await service.reorderTags(tx, A, [extra.id])).toMatchObject({ ok: false, error: "invalid" });

      mustOk(await service.deleteTag(tx, A, tags[tags.length - 1]?.id ?? ""));
    });
  });

  it("ações em massa: etiquetar e excluir (LGPD) em cascata", async () => {
    await rollback(async (tx) => {
      const tag = (await service.listTags(tx, A))[0];
      if (!tag) throw new Error("sem etiqueta");
      const c = mustOk(await service.createContact(tx, A, input()));
      mustOk(await service.addContactNote(tx, A, c.id, "nota"));
      expect(mustOk(await service.tagContacts(tx, A, [c.id], tag.id)).updated).toBe(1);
      expect(mustOk(await service.tagContacts(tx, A, [c.id], tag.id)).updated).toBe(0);
      await service.registerOptOut(tx, A.organizationId, c.id, "SAIR");

      expect(mustOk(await service.deleteContacts(tx, A, [c.id])).deleted).toBe(1);
      for (const table of [schema.contactNotes, schema.contactTags, schema.consents, schema.contactEvents]) {
        const rows = await tx.select().from(table).where(eq(table.contactId, c.id));
        expect(rows).toHaveLength(0);
      }
    });
  });

  it("importação: cria, atualiza por telefone e informa os pulados; o arquivo é de uso único", async () => {
    await rollback(async (tx) => {
      const existing = mustOk(await service.createContact(tx, A, input({ name: "Já Existe", phone: "+5567990001111" })));
      const csv = [
        "Nome;Celular;E-mail;Nascimento",
        "Nova Pessoa;(67) 99000-2222;nova@exemplo.com;12/04/1983",
        "Já Existe;67 99000-1111;;",
        "Sem Telefone;;;",
        "Telefone Ruim;123;;",
        "Repetida;(67) 99000-2222;;",
      ].join("\n");
      const preview = mustOk(await previewImport(tx, A, { name: "contatos.csv", size: csv.length, text: csv }));
      expect(preview.totalRows).toBe(5);
      expect(preview.columns.map((c) => c.suggested)).toEqual(["name", "phone", "email", "birthDate"]);

      const tag = (await service.listTags(tx, A))[0];
      const result = mustOk(
        await commitImport(tx, A, {
          importId: preview.importId,
          mapping: { c1: "name", c2: "phone", c3: "email", c4: "birthDate" },
          origin: "customer",
          originNote: "Planilha antiga",
          confirmedRelationship: true,
          tagIds: tag ? [tag.id] : [],
          listId: null,
        }),
      );
      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.skipped).toEqual([
        { row: 4, reason: "no_phone" },
        { row: 5, reason: "invalid_phone" },
        { row: 6, reason: "duplicate" },
      ]);
      const created = await service.findContactByPhone(tx, A.organizationId, "+5567990002222");
      expect(created).not.toBeNull();
      const detail = created ? await service.getContact(tx, A, created.id) : null;
      expect(detail).toMatchObject({ origin: "customer", isCustomer: true, birthDate: "1983-04-12", email: "nova@exemplo.com" });
      expect((await service.getContact(tx, A, existing.id))?.tagIds).toEqual(tag ? [tag.id] : []);

      const again = await commitImport(tx, A, { importId: preview.importId, mapping: { c1: "name", c2: "phone" }, origin: "customer", originNote: "", confirmedRelationship: true, tagIds: [], listId: null });
      expect(again).toMatchObject({ ok: false, error: "not_found" });
    });
  });

  it("importação: outra empresa não confirma o arquivo de A; XLSX é recusado", async () => {
    await rollback(async (tx) => {
      const preview = mustOk(await previewImport(tx, A, { name: "a.csv", size: 20, text: "Nome;Telefone\nA;67999990000\n" }));
      await actAs(tx, B);
      const stolen = await commitImport(tx, B, { importId: preview.importId, mapping: { c1: "name", c2: "phone" }, origin: "form", originNote: "", confirmedRelationship: true, tagIds: [], listId: null });
      expect(stolen).toMatchObject({ ok: false, error: "not_found" });
      await actAs(tx, A);
      expect(await previewImport(tx, A, { name: "planilha.xlsx", size: 100, text: "PK" })).toMatchObject({ ok: false, error: "unsupported_format" });
    });
  });

  it("exportação: ; + BOM e proteção contra injeção de fórmula", async () => {
    await rollback(async (tx) => {
      mustOk(await service.createContact(tx, A, input({ name: "=HYPERLINK(1)", phone: "+5567990003333" })));
      const out = await exportContacts(tx, A, { contactIds: null, filter: { q: "HYPERLINK" } });
      expect(out.count).toBe(1);
      expect(out.csv.startsWith("﻿Nome;Telefone;E-mail")).toBe(true);
      expect(out.csv).toContain("'=HYPERLINK(1);'+5567990003333");
      expect(out.fileName).toMatch(/^clientes-\d{4}-\d{2}-\d{2}\.csv$/);
    });
  });

  it("convite: elegibilidade, um só para sempre, interpretação da resposta e bloqueio permanente", async () => {
    await rollback(async (tx) => {
      const ch1 = await insertChannel(tx, A, "Recepção 1");
      const mem = createInMemoryPorts([{ id: ch1, name: "Recepção 1", provider: "qr", connected: true, messagesSentToday: 0, warmupDay: null }]);
      const channels = await mem.ports.channels.listInviteChannels(A.organizationId);

      const eligible = mustOk(await service.createContact(tx, A, input({ name: "Elegível", origin: "form" })));
      const inbound = mustOk(await service.createContact(tx, A, input({ name: "Mandou primeiro", origin: "inbound" })));
      const noOrigin = await service.upsertContactByPhone(tx, A.organizationId, { phone: randomPhone(), name: "Sem origem" });
      const before = await getInviteOverview(tx, A, channels);
      expect(before.eligibleContactIds).toContain(eligible.id);
      expect(before.eligibleContactIds).not.toContain(inbound.id);
      expect(before.ineligibleCounts.inbound).toBeGreaterThanOrEqual(1);
      expect(before.ineligibleCounts.no_origin).toBeGreaterThanOrEqual(1);
      expect(noOrigin?.created).toBe(true);

      const sent = mustOk(await inviteContacts(tx, A, { contactIds: [eligible.id, inbound.id], channelId: ch1 }, channels, mem.ports.queue));
      expect(sent.queued).toBe(1);
      expect(sent.skipped).toEqual([{ contactId: inbound.id, reason: "inbound" }]);
      expect(mem.jobs).toHaveLength(1);
      expect(mem.jobs[0]?.text).toContain("Casa Alvorada Odontologia");
      expect(mem.jobs[0]?.text).toContain("Elegível");

      // um convite só, para sempre
      const again = await inviteContacts(tx, A, { contactIds: [eligible.id], channelId: ch1 }, channels, mem.ports.queue);
      expect(again).toMatchObject({ ok: false, error: "none_eligible" });
      expect(mem.jobs).toHaveLength(1);

      // canal desconectado
      const offline = await inviteContacts(tx, A, { contactIds: [eligible.id], channelId: ch1 }, [{ ...channels[0]!, connected: false }], mem.ports.queue);
      expect(offline).toMatchObject({ ok: false, error: "channel_unavailable" });

      // resposta ambígua não aceita; SIM aceita e guarda a prova; SAIR bloqueia para sempre
      const ambiguous = await service.registerConsentReply(tx, A.organizationId, eligible.id, "quem é?");
      expect(ambiguous).toMatchObject({ handled: true, status: "pending", changed: false });
      const granted = await service.registerConsentReply(tx, A.organizationId, eligible.id, "SIM, pode mandar");
      expect(granted).toMatchObject({ status: "granted", changed: true });
      const detail = await service.getContact(tx, A, eligible.id);
      expect(detail?.consent).toMatchObject({ status: "granted", replyText: "SIM, pode mandar", method: "invite" });
      expect(detail?.consent?.inviteText).toContain("Responda SIM");

      await service.registerOptOut(tx, A.organizationId, eligible.id, "SAIR");
      const blocked = await service.registerConsentReply(tx, A.organizationId, eligible.id, "sim");
      expect(blocked).toMatchObject({ status: "denied", changed: false });
      expect((await service.listContacts(tx, A, { ...query, consent: "denied", q: "Elegível" })).total).toBe(1);
    });
  });

  it("convites pendentes há mais de 7 dias valem como expirados e o job os marca", async () => {
    await rollback(async (tx) => {
      const ch1 = await insertChannel(tx, A, "Recepção");
      const mem = createInMemoryPorts([{ id: ch1, name: "Recepção", provider: "qr", connected: true, messagesSentToday: 0, warmupDay: null }]);
      const c = mustOk(await service.createContact(tx, A, input({ origin: "service" })));
      mustOk(await inviteContacts(tx, A, { contactIds: [c.id], channelId: ch1 }, await mem.ports.channels.listInviteChannels(A.organizationId), mem.ports.queue));
      const sentAt = new Date("2025-06-01T12:00:00Z");
      await service.markInviteSent(tx, A.organizationId, c.id, sentAt);
      const later = new Date("2025-06-09T12:00:00Z");
      expect((await service.getContact(tx, A, c.id, later))?.consent?.status).toBe("expired");
      expect((await service.listContacts(tx, A, { ...query, consent: "expired", q: c.name }, later)).total).toBe(1);
      expect(await service.expireStaleInvites(tx, A.organizationId, later)).toBeGreaterThanOrEqual(1);
    });
  });

  it("upsertContactByPhone é idempotente e normaliza o telefone", async () => {
    await rollback(async (tx) => {
      const first = await service.upsertContactByPhone(tx, A.organizationId, { phone: "(67) 99000-4444", name: "Via conversa", source: "inbound" });
      const second = await service.upsertContactByPhone(tx, A.organizationId, { phone: "+5567990004444", name: "Outro nome" });
      expect(first).toMatchObject({ created: true, contact: { phone: "+5567990004444", name: "Via conversa" } });
      expect(second).toMatchObject({ created: false });
      expect(second?.contact.id).toBe(first?.contact.id);
      expect((await service.findContactByPhone(tx, A.organizationId, "67990004444"))?.id).toBe(first?.contact.id);
      expect(await service.upsertContactByPhone(tx, A.organizationId, { phone: "abc" })).toBeNull();
    });
  });
});
