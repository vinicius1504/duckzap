import { createDb, schema, withOrg, type Transaction } from "@duckzap/db";
import type { ImportOrigin } from "@duckzap/contracts/contacts";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, describe, expect, it } from "vitest";
import { sealCredentials } from "../channels/repo";
import { loadChannelsConfig } from "../channels/config";
import { createProviderRegistry } from "../channels/providers/registry";
import type { FetchLike } from "../channels/providers/shared";
import { previewImport } from "./import-export";
import type { ServiceCtx } from "./result";
import * as service from "./service";
import { commitWhatsappImport, previewWhatsappImport, type RunInTenant, type WhatsappImportDeps } from "./whatsapp-import";

// INTEGRAÇÃO — mesmas regras de contacts.integration.test.ts (CLIENTES_INTEGRATION=1, DATABASE_URL com o papel duckzap_app,
// banco descartável migrado e semeado). Cada teste roda numa transação desfeita no fim. O provedor é a Evolution REAL
// (adaptador) falando com um `fetch` falso: nenhum acesso à rede e todos os nomes/números abaixo são inventados.
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

const actAs = (tx: Transaction, ctx: ServiceCtx) => tx.execute(sql`select set_config('app.org_id', ${ctx.organizationId}, true)`);
const mustOk = <T>(r: { ok: true; data: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.data;
};

// Contatos "do WhatsApp" que a Evolution falsa devolve
const OWN = "5567999990000";
const jidItems = (items: { jid: string; name?: string | null }[]) => items.map((i) => ({ remoteJid: i.jid, pushName: i.name ?? null, isSaved: true, type: "contact" }));
const WHATSAPP = jidItems([
  { jid: `${OWN}@s.whatsapp.net`, name: "Eu mesmo" }, // o próprio número do canal
  { jid: "5567999990001@s.whatsapp.net", name: "Ana Souza" },
  { jid: "5567999990002@s.whatsapp.net", name: "Bruno Lima" }, // já é cliente (criado no teste)
  { jid: "556799990003@s.whatsapp.net", name: "+55 67 9999-0003" }, // 12 dígitos; nome é o número → vazio
  { jid: "5567999990004@s.whatsapp.net", name: "Carla Dias" },
  { jid: "5567999990004@s.whatsapp.net", name: "Carla Dias" }, // repetido
  { jid: "120363000000000001@g.us", name: "Família" },
  { jid: "98765432109876@lid" },
  { jid: "0@s.whatsapp.net", name: "WhatsApp" },
  { jid: "status@broadcast" },
]);

function setup(options: { reply?: () => Response } = {}) {
  const requests: string[] = [];
  const fetch: FetchLike = async (url) => {
    requests.push(url);
    return options.reply?.() ?? new Response(JSON.stringify(WHATSAPP), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = loadChannelsConfig({ EVOLUTION_URL: "http://evolution.test", EVOLUTION_API_KEY: "GLOBAL-KEY-0001" });
  const deps: WhatsappImportDeps = { providers: createProviderRegistry(config, { fetch }), log: { warn: () => {} } };
  return { deps, requests };
}

async function insertChannel(
  tx: Transaction,
  ctx: ServiceCtx,
  over: { name?: string; type?: "whatsapp_qr" | "whatsapp_official" | "instagram"; provider?: string; status?: "connected" | "disconnected"; address?: string | null } = {},
) {
  const id = uuidv7();
  await tx.insert(schema.channels).values({
    id,
    organizationId: ctx.organizationId,
    name: over.name ?? `Canal ${id.slice(-6)}`,
    type: over.type ?? "whatsapp_qr",
    provider: over.provider ?? "evolution",
    status: over.status ?? "connected",
    address: over.address === undefined ? `+${OWN}` : over.address,
    credentialsEnc: sealCredentials(ctx.organizationId, { instanceName: "dz-test-instance", instanceToken: "INSTANCE-TOKEN-0001" }),
    webhookTokenHash: `hash-${id}`,
    webhookTokenEnc: `enc-${id}`,
  });
  return id;
}

const runIn = (tx: Transaction): RunInTenant => (fn) => fn(tx);
const commitBody = (importId: string, rows: { phone: string; name: string }[], over: { origin?: ImportOrigin; tagIds?: string[]; listId?: string | null } = {}) => ({
  importId,
  rows,
  origin: over.origin ?? ("customer" as const),
  originNote: "Agenda do balcão",
  confirmedRelationship: true as const,
  tagIds: over.tagIds ?? [],
  listId: over.listId ?? null,
});
const newContact = (phone: string, name = "Cliente de Teste") => ({
  name,
  phone,
  email: "",
  instagram: "",
  isCustomer: false,
  tagIds: [],
  origin: "form" as const,
  originNote: "",
  ownerId: null,
  birthDate: "",
});

describe.skipIf(!enabled)("Importar do WhatsApp (precisa da migration)", () => {
  it("prévia: classifica, tira o próprio número e repetidos, marca quem já é cliente e ordena", async () => {
    await rollback(async (tx) => {
      mustOk(await service.createContact(tx, A, newContact("+5567999990002", "Bruno (cadastro)")));
      const channelId = await insertChannel(tx, A, { name: "Balcão" });
      const { deps, requests } = setup();
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, deps));

      expect(requests).toEqual(["http://evolution.test/chat/findContacts/dz-test-instance"]);
      expect(preview).toMatchObject({ channelId, channelName: "Balcão" });
      expect(preview.candidates).toEqual([
        { phone: "+5567999990001", name: "Ana Souza", existing: false },
        { phone: "+5567999990002", name: "Bruno Lima", existing: true },
        { phone: "+5567999990004", name: "Carla Dias", existing: false },
        { phone: "+556799990003", name: "", existing: false }, // sem nome vai para o fim
      ]);
      expect(preview.summary).toEqual({ found: 10, people: 4, existing: 1, groups: 1, hidden: 1, other: 4, noName: 1 });
      const s = preview.summary;
      expect(s.people + s.groups + s.hidden + s.other).toBe(s.found);
    });
  });

  it("a lista fica guardada com o nome 'WhatsApp · canal' e expira como a da planilha", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A, { name: "Balcão" });
      const now = new Date("2026-10-28T12:00:00Z");
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps, now));
      const [staged] = await tx.select().from(schema.contactImports).where(eq(schema.contactImports.id, preview.importId));
      expect(staged?.fileName).toBe("WhatsApp · Balcão");
      expect(staged?.rows).toHaveLength(4);
      expect(staged?.expiresAt.toISOString()).toBe("2026-10-28T13:00:00.000Z");
      expect(staged?.createdBy).toBe(A.userId);
    });
  });

  it("confirmar: cria os marcados com os nomes corrigidos, título do evento coerente, etiqueta e lista", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A, { name: "Balcão" });
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps));
      const tag = (await service.listTags(tx, A))[0]!;
      const list = mustOk(await service.createContactList(tx, A, { name: "Agenda do balcão", description: "", kind: "static", filter: null }));

      const result = mustOk(
        await commitWhatsappImport(
          tx,
          A,
          commitBody(
            preview.importId,
            [
              { phone: "+5567999990001", name: "  Ana Souza Corrigida  " },
              { phone: "+556799990003", name: "" }, // sem nome → "Sem nome"
            ],
            { tagIds: [tag.id], listId: list.id },
          ),
        ),
      );
      expect(result).toEqual({ created: 2, updated: 0, skipped: [] });

      const ana = (await service.findContactByPhone(tx, A.organizationId, "+5567999990001"))!;
      const detail = (await service.getContact(tx, A, ana.id))!;
      expect(detail).toMatchObject({ name: "Ana Souza Corrigida", origin: "customer", isCustomer: true, originNote: "Agenda do balcão", tagIds: [tag.id] });
      expect(detail.history.find((e) => e.kind === "import")).toMatchObject({ title: "Importado de WhatsApp · Balcão" });
      const semNome = (await service.findContactByPhone(tx, A.organizationId, "+556799990003"))!;
      expect((await service.getContact(tx, A, semNome.id))?.name).toBe("Sem nome");

      const members = await tx.select().from(schema.contactListMembers).where(eq(schema.contactListMembers.listId, list.id));
      expect(members).toHaveLength(2);
      // desmarcados não entram
      expect(await service.findContactByPhone(tx, A.organizationId, "+5567999990004")).toBeNull();
    });
  });

  it("só aceita telefones que vieram da prévia, e a recusa não consome a importação", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps));

      for (const phone of ["+5567999991111", "5567999990001", "+5567999990000", "' or 1=1 --"]) {
        const refused = await commitWhatsappImport(tx, A, commitBody(preview.importId, [{ phone: "+5567999990001", name: "Ana" }, { phone, name: "Intruso" }]));
        expect(refused, phone).toMatchObject({ ok: false, error: "invalid" });
      }
      expect(await service.findContactByPhone(tx, A.organizationId, "+5567999990001")).toBeNull();
      expect(await service.findContactByPhone(tx, A.organizationId, "+5567999991111")).toBeNull();

      // a importação continua valendo para um pedido correto
      const ok = await commitWhatsappImport(tx, A, commitBody(preview.importId, [{ phone: "+5567999990001", name: "Ana" }]));
      expect(mustOk(ok)).toMatchObject({ created: 1 });
    });
  });

  it("etiqueta ou lista inexistente é recusada sem consumir a importação", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps));
      const rows = [{ phone: "+5567999990001", name: "Ana" }];
      expect(await commitWhatsappImport(tx, A, commitBody(preview.importId, rows, { tagIds: [uuidv7()] }))).toMatchObject({ ok: false, error: "invalid" });
      expect(await commitWhatsappImport(tx, A, commitBody(preview.importId, rows, { listId: uuidv7() }))).toMatchObject({ ok: false, error: "invalid" });
      expect(mustOk(await commitWhatsappImport(tx, A, commitBody(preview.importId, rows)))).toMatchObject({ created: 1 });
    });
  });

  it("quem já é cliente é atualizado (etiqueta e lista), nunca duplicado; repetir a seleção não duplica", async () => {
    await rollback(async (tx) => {
      const existing = mustOk(await service.createContact(tx, A, newContact("+5567999990002", "Bruno (cadastro)")));
      const channelId = await insertChannel(tx, A);
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps));
      const tag = (await service.listTags(tx, A))[0]!;
      const list = mustOk(await service.createContactList(tx, A, { name: "Lista de atualização", description: "", kind: "static", filter: null }));

      const result = mustOk(
        await commitWhatsappImport(
          tx,
          A,
          commitBody(
            preview.importId,
            [
              { phone: "+5567999990002", name: "Bruno do WhatsApp" },
              { phone: "+5567999990002", name: "Bruno de novo" }, // repetido na própria seleção
            ],
            { tagIds: [tag.id], listId: list.id },
          ),
        ),
      );
      expect(result).toEqual({ created: 0, updated: 1, skipped: [{ row: 2, reason: "duplicate" }] });
      const after = (await service.getContact(tx, A, existing.id))!;
      expect(after.name).toBe("Bruno (cadastro)"); // nome já cadastrado não é sobrescrito
      expect(after.tagIds).toEqual([tag.id]);
      const members = await tx.select().from(schema.contactListMembers).where(eq(schema.contactListMembers.listId, list.id));
      expect(members.map((m) => m.contactId)).toEqual([existing.id]);
      const total = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.phone, "+5567999990002"));
      expect(total).toHaveLength(1);
    });
  });

  it("uso único: repetir o mesmo importId falha; expirada também", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const now = new Date("2026-10-28T12:00:00Z");
      const rows = [{ phone: "+5567999990001", name: "Ana" }];

      const first = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps, now));
      mustOk(await commitWhatsappImport(tx, A, commitBody(first.importId, rows), now));
      expect(await commitWhatsappImport(tx, A, commitBody(first.importId, rows), now)).toMatchObject({ ok: false, error: "not_found" });

      const second = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup().deps, now));
      const later = new Date(now.getTime() + 61 * 60 * 1000);
      expect(await commitWhatsappImport(tx, A, commitBody(second.importId, rows), later)).toMatchObject({ ok: false, error: "not_found" });
      expect(await commitWhatsappImport(tx, A, commitBody(uuidv7(), rows), now)).toMatchObject({ ok: false, error: "not_found" });
    });
  });

  it("a importação de uma planilha não serve neste caminho (e vice-versa não vaza telefone)", async () => {
    await rollback(async (tx) => {
      const sheet = mustOk(await previewImport(tx, A, { name: "agenda.csv", size: 40, text: "Nome;Telefone\nAna;+5567999990001\n" }));
      const refused = await commitWhatsappImport(tx, A, commitBody(sheet.importId, [{ phone: "+5567999990001", name: "Ana" }]));
      expect(refused).toMatchObject({ ok: false, error: "not_found" });
    });
  });

  it("outra empresa: canal de A não existe para B; a importação de A não é confirmada por B", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const { deps } = setup();
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, deps));

      await actAs(tx, B);
      expect(await previewWhatsappImport(runIn(tx), B, { channelId }, deps)).toMatchObject({ ok: false, error: "channel_not_found" });
      expect(await commitWhatsappImport(tx, B, commitBody(preview.importId, [{ phone: "+5567999990001", name: "Ana" }]))).toMatchObject({ ok: false, error: "not_found" });
      await actAs(tx, A);
      // e A ainda consegue concluir
      expect(mustOk(await commitWhatsappImport(tx, A, commitBody(preview.importId, [{ phone: "+5567999990001", name: "Ana" }])))).toMatchObject({ created: 1 });
    });
  });

  it("canal inexistente ou id malformado é 'não encontrado'", async () => {
    await rollback(async (tx) => {
      const { deps, requests } = setup();
      for (const channelId of [uuidv7(), "abc", "1; drop table channels"]) {
        expect(await previewWhatsappImport(runIn(tx), A, { channelId }, deps)).toMatchObject({ ok: false, error: "channel_not_found" });
      }
      expect(requests).toHaveLength(0);
    });
  });

  it("WhatsApp oficial (Meta) e Instagram não têm lista de contatos; canal desconectado é 409; nada chama o provedor", async () => {
    await rollback(async (tx) => {
      const { deps, requests } = setup();
      const meta = await insertChannel(tx, A, { type: "whatsapp_official", provider: "meta_cloud" });
      const insta = await insertChannel(tx, A, { type: "instagram", provider: "instagram" });
      const metaDown = await insertChannel(tx, A, { type: "whatsapp_official", provider: "meta_cloud", status: "disconnected" });
      const qrDown = await insertChannel(tx, A, { status: "disconnected" });

      for (const channelId of [meta, insta, metaDown]) {
        expect(await previewWhatsappImport(runIn(tx), A, { channelId }, deps)).toMatchObject({ ok: false, error: "channel_unsupported" });
      }
      const down = await previewWhatsappImport(runIn(tx), A, { channelId: qrDown }, deps);
      expect(down).toMatchObject({ ok: false, error: "channel_disconnected" });
      expect(requests).toHaveLength(0);
    });
  });

  it("Evolution fora do ar → provider_unavailable; número desconectado no provedor → channel_disconnected; nada é guardado", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const down = await previewWhatsappImport(runIn(tx), A, { channelId }, setup({ reply: () => new Response("{}", { status: 503 }) }).deps);
      expect(down).toMatchObject({ ok: false, error: "provider_unavailable" });
      const loggedOut = await previewWhatsappImport(runIn(tx), A, { channelId }, setup({ reply: () => new Response("{}", { status: 401 }) }).deps);
      expect(loggedOut).toMatchObject({ ok: false, error: "channel_disconnected" });
      const stored = await tx.select().from(schema.contactImports);
      expect(stored).toHaveLength(0);
    });
  });

  it("mais contatos que o limite → too_large", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const big = jidItems(Array.from({ length: 20_001 }, (_, i) => ({ jid: `55${String(1_000_000_000 + i)}@s.whatsapp.net`, name: `P${i}` })));
      const result = await previewWhatsappImport(runIn(tx), A, { channelId }, setup({ reply: () => new Response(JSON.stringify(big), { status: 200 }) }).deps);
      expect(result).toMatchObject({ ok: false, error: "too_large" });
    });
  });

  it("lista vazia no WhatsApp: prévia vazia, sem erro", async () => {
    await rollback(async (tx) => {
      const channelId = await insertChannel(tx, A);
      const preview = mustOk(await previewWhatsappImport(runIn(tx), A, { channelId }, setup({ reply: () => new Response("[]", { status: 200 }) }).deps));
      expect(preview.candidates).toEqual([]);
      expect(preview.summary).toEqual({ found: 0, people: 0, existing: 0, groups: 0, hidden: 0, other: 0, noName: 0 });
    });
  });
});
