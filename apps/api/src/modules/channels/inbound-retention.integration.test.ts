import { createDb, schema, withOrg } from "@duckzap/db";
import { eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerInboundHandler } from "../../lib/inbound";
import { eraseConversationData } from "../conversations/erasure";
import { MAX_ATTEMPTS, processInbound, purgeInboundEvents, recordInbound } from "./inbound-store";
import { createChannelsRuntime } from "./runtime";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

/**
 * INTEGRAÇÃO (LGPD) — `inbound_events.payload` não pode guardar telefone/nome/texto depois de processado.
 * Usa o banco descartável (DATABASE_URL como `duckzap_app`); sem DATABASE_URL o arquivo é ignorado.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const url = process.env.DATABASE_URL;
// empresa ATIVA própria (criada no beforeAll): o canal daqui não pode ser apagado/alterado por testes de outros arquivos em paralelo
let ORG = "";
const SUFFIX = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
const PHONE = `+55679${SUFFIX}`;
const run = Math.random().toString(36).slice(2, 8);

describe.skipIf(!url || !process.env.DATABASE_ADMIN_URL)("Entrada de webhooks — retenção e LGPD", () => {
  const { db, close } = createDb(url ?? "postgres://invalid", { max: 3 });
  const rt = createChannelsRuntime();
  const channelId = uuidv7();
  const rawBody = JSON.stringify({ entry: [{ from: PHONE, name: "Maria Segredo", text: "meu cpf é 123.456.789-09" }] });
  const message = (externalId: string, from = PHONE) => ({
    type: "message" as const,
    externalId,
    from,
    name: "Maria Segredo",
    kind: "text" as const,
    text: "meu cpf é 123.456.789-09",
    at: "2026-10-26T12:00:00.000Z",
  });
  const rowsOf = () => withOrg(db, ORG, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.channelId, channelId)));
  const dump = (rows: unknown) => JSON.stringify(rows);

  let org: SecondOrg;
  beforeAll(async () => {
    org = await createSecondOrg("retencao");
    ORG = org.orgId;
    await withOrg(db, ORG, (tx) =>
      tx.insert(schema.channels).values({
        id: channelId,
        organizationId: ORG,
        name: `it-${run}-retencao`,
        type: "whatsapp_official",
        provider: "meta_cloud",
        status: "connected",
        webhookTokenHash: `hash-${run}-${channelId}`,
        webhookTokenEnc: "enc",
      }),
    );
    registerInboundHandler(async (context) => {
      if (context.channelId === channelId && context.event.type === "message" && context.event.externalId === `falha-${run}`) throw new Error("downstream fora");
    });
  });

  afterAll(async () => {
    await org?.remove(); // cascata: canal, eventos e contatos da empresa de teste
    await close();
  });

  it("após processar com sucesso, payload e evento ficam minimizados (sem telefone, nome, texto)", async () => {
    const { ids } = await recordInbound(db, { organizationId: ORG, channelId, rawBody, events: [message(`ok-${run}`)], parseFailed: false });
    expect(dump(await rowsOf())).toContain(PHONE); // antes de processar o dado está lá
    const result = await processInbound(db, ORG, rt, { ids });
    expect(result.processed).toBe(1);
    const [row] = (await rowsOf()).filter((r) => r.externalId === `msg:ok-${run}`);
    expect(row?.processedAt).not.toBeNull();
    expect(row?.payload).toMatchObject({ minimized: true, type: "message" });
    expect(dump(row)).not.toMatch(/55679|Maria|cpf|123\.456/);
  });

  it("falha mantém o payload até esgotar as tentativas; depois (dead letter) ele é limpo", async () => {
    const { ids } = await recordInbound(db, { organizationId: ORG, channelId, rawBody, events: [message(`falha-${run}`)], parseFailed: false });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await processInbound(db, ORG, rt, { ids });
      await withOrg(db, ORG, (tx) => tx.update(schema.inboundEvents).set({ nextAttemptAt: null }).where(inArray(schema.inboundEvents.id, ids)));
      const [row] = await withOrg(db, ORG, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.id, ids[0]!)));
      expect(dump(row)).toContain(PHONE);
    }
    await processInbound(db, ORG, rt, { ids });
    const [dead] = await withOrg(db, ORG, (tx) => tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.id, ids[0]!)));
    expect(dead?.attempts).toBe(MAX_ATTEMPTS);
    expect(dead?.processedAt).toBeNull();
    expect(dump(dead)).not.toMatch(/55679|Maria|cpf/);
  });

  it("purgeInboundEvents minimiza antigos (inclusive unparsed) e apaga os muito antigos", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const veryOld = new Date(Date.now() - 120 * 86_400_000);
    const mk = (externalId: string, kind: string, receivedAt: Date, processedAt: Date | null) => ({
      id: uuidv7(),
      organizationId: ORG,
      channelId,
      externalId,
      kind,
      payload: { from: PHONE, text: "segredo" },
      event: kind === "unparsed" ? null : { type: kind, from: PHONE },
      receivedAt,
      processedAt,
    });
    await withOrg(db, ORG, (tx) =>
      tx.insert(schema.inboundEvents).values([
        mk(`p-old-${run}`, "message", old, old),
        mk(`p-veryold-${run}`, "message", veryOld, veryOld),
        mk(`unparsed-${run}`, "unparsed", new Date(Date.now() - 10 * 86_400_000), new Date()),
        mk(`p-recent-${run}`, "message", new Date(), new Date()),
        mk(`pending-old-${run}`, "message", old, null),
      ]),
    );
    const result = await purgeInboundEvents(db);
    expect(result.minimized).toBeGreaterThanOrEqual(2);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const rows = await rowsOf();
    const by = (key: string) => rows.find((r) => r.externalId === key);
    expect(by(`p-veryold-${run}`)).toBeUndefined();
    expect(dump(by(`p-old-${run}`))).not.toContain(PHONE);
    expect(dump(by(`unparsed-${run}`))).not.toContain("segredo");
    expect(dump(by(`p-recent-${run}`))).toContain("segredo"); // recente e já processado: ainda dentro da janela
    expect(dump(by(`pending-old-${run}`))).toContain("segredo"); // pendente com tentativas sobrando nunca é tocado
  });

  it("excluir contato minimiza e encerra os eventos pendentes do telefone dele (e só dele)", async () => {
    const contactId = uuidv7();
    await withOrg(db, ORG, (tx) => tx.insert(schema.contacts).values({ id: contactId, organizationId: ORG, name: `it-${run}`, phone: PHONE }));
    const other = "+5511977776666";
    const { ids } = await recordInbound(db, {
      organizationId: ORG,
      channelId,
      rawBody,
      events: [message(`erase-a-${run}`, PHONE.slice(1)), message(`erase-b-${run}`, other)],
      parseFailed: false,
    });
    expect(ids).toHaveLength(2);
    await withOrg(db, ORG, async (tx) => {
      await eraseConversationData(tx, ORG, [contactId]);
      await tx.delete(schema.contacts).where(eq(schema.contacts.id, contactId));
    });
    const rows = await rowsOf();
    const a = rows.find((r) => r.externalId === `msg:erase-a-${run}`);
    const b = rows.find((r) => r.externalId === `msg:erase-b-${run}`);
    expect(a?.processedAt).not.toBeNull();
    expect(a?.error).toBe("contact_erased");
    expect(dump(a)).not.toMatch(/55679|Maria|cpf/);
    expect(b?.processedAt).toBeNull();
    expect(dump(b)).toContain("5511977776666");
  });
});
