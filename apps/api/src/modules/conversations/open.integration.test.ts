import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import type { RealtimeEnvelope } from "@duckzap/contracts/realtime";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, ne } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import { setRealtimePublisher, withOrgRealtime } from "../../lib/realtime";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadConversationsConfig } from "./config";
import { NO_CHANNEL_TO_OPEN, openConversationForContact } from "./open";
import type { ConvCtx } from "./queries";
import { conversationsRoutes } from "./routes";

/**
 * INTEGRAÇÃO — "Abrir conversa" (POST /v1/conversations/open). Banco descartável (NUNCA o `duckzap`):
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=… DATABASE_ADMIN_URL=… npx vitest run src/modules/conversations/open
 * Cria as próprias empresas ATIVAS (createSecondOrg) e as remove no fim. Publicador de tempo real falso; nada sai para a rede.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CONVERSATIONS_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

const run = Math.random().toString(36).slice(2, 8);
const phone = () => `+55679${randomInt(10_000_000, 99_999_999)}`;

describe.skipIf(!enabled)("Abrir conversa com um cliente — integração", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 8 });
  afterAll(close);

  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const app = new OpenAPIHono();
  app.route("/v1", conversationsRoutes(deps, { config, now: () => new Date(), scheduleAiTurn: () => {}, register: false }));
  app.onError(onError);
  const call = (as: string | null, body?: unknown) =>
    app.request("/v1/conversations/open", {
      method: "POST",
      headers: { ...(as ? { "x-test-user": as } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;

  let captured: RealtimeEnvelope[] = [];
  const raw: string[] = [];
  setRealtimePublisher((envelope) => {
    captured.push(envelope);
    raw.push(JSON.stringify(envelope));
  });
  afterAll(() => setRealtimePublisher(null));
  const take = () => {
    const out = captured;
    captured = [];
    return out;
  };

  let main: SecondOrg;
  let bare: SecondOrg; // sem canal conectado
  let other: SecondOrg;
  let suspended: SecondOrg;
  const chan = uuidv7();
  const names = { marina: "Marina Alves", rafael: "Rafael Costa" };

  async function insertChannel(org: string, id: string, status = "connected") {
    await withOrg(db, org, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: org,
        name: `Recepção ${run}`,
        type: "whatsapp_qr",
        provider: "evolution",
        status,
        address: "+556733330000",
        webhookTokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
        webhookTokenEnc: encryptSecret(org, "token"),
      }),
    );
  }
  async function newContact(org: string, over: Partial<typeof schema.contacts.$inferInsert> = {}) {
    const id = uuidv7();
    await withOrg(db, org, (tx) => tx.insert(schema.contacts).values({ id, organizationId: org, name: `Cliente Sigiloso ${run}-${id.slice(-6)}`, phone: phone(), ...over }));
    return id;
  }
  const convsOf = (org: string, contactId: string) =>
    withOrg(db, org, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, contactId)));
  const messagesOf = (org: string, conversationId: string) =>
    withOrg(db, org, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)));

  beforeAll(async () => {
    main = await createSecondOrg("open", { planSlug: "empresarial", ownerName: names.marina, extra: [{ key: "agente", role: "member", name: names.rafael }] });
    bare = await createSecondOrg("open-semcanal");
    other = await createSecondOrg("open-outra");
    suspended = await createSecondOrg("open-suspensa", { status: "expired", daysToEnd: -5 });
    for (const [key, o] of Object.entries({ owner: main, bare, other, suspended })) {
      sessions[key] = { user: { id: o.userId, name: o.userName, email: o.userEmail }, session: { id: `s-${key}`, activeOrganizationId: o.orgId } };
    }
    const agent = main.members.agente!;
    sessions.agente = { user: { id: agent.userId, name: agent.name, email: agent.email }, session: { id: "s-agente", activeOrganizationId: main.orgId } };
    await insertChannel(main.orgId, chan);
    await insertChannel(other.orgId, uuidv7());
    await insertChannel(bare.orgId, uuidv7(), "disconnected"); // existe, mas não está conectado
  });
  afterAll(async () => {
    await Promise.all([main, bare, other, suspended].map((o) => o?.remove()));
  });

  it("autorização: 401 sem sessão; 403 com a conta suspensa; 422 com id malformado; 404 com id desconhecido", async () => {
    expect((await call(null, { contactId: uuidv7() })).status).toBe(401);

    const contact = await newContact(main.orgId);
    const blocked = await call("suspended", { contactId: contact });
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).error.code).toBe("account_suspended");

    expect((await call("owner", { contactId: "nao-e-uuid" })).status).toBe(422);
    expect((await call("owner", {})).status).toBe(422);
    const unknown = await call("owner", { contactId: uuidv7() });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error.code).toBe("not_found");
  });

  it("cliente de OUTRA empresa responde 404, igual a um id que não existe (e nada é criado)", async () => {
    const foreign = await newContact(other.orgId);
    const res = await call("owner", { contactId: foreign });
    const same = await call("owner", { contactId: uuidv7() });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual(await json(same));
    expect(await convsOf(other.orgId, foreign)).toHaveLength(0);
  });

  it("sem canal conectado: 409 no_channel com a mensagem do produto, e nada é criado", async () => {
    const contact = await newContact(bare.orgId);
    const res = await call("bare", { contactId: contact });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: { code: "no_channel", message: "Conecte um canal em Canais para conversar com este contato." } });
    expect(NO_CHANNEL_TO_OPEN).toBe("Conecte um canal em Canais para conversar com este contato.");
    expect(await convsOf(bare.orgId, contact)).toHaveLength(0);
  });

  it("cliente novo: cria a conversa vazia no canal padrão, com a pessoa como responsável, modo Só humano e a linha de início; chamar de novo devolve a mesma", async () => {
    const contact = await newContact(main.orgId);
    take();
    const res = await call("owner", { contactId: contact });
    expect(res.status).toBe(200);
    const { conversationId } = await json<{ conversationId: string }>(res);

    const [conv] = await convsOf(main.orgId, contact);
    expect(conv).toMatchObject({ id: conversationId, channelId: chan, status: "human_active", mode: "human", assigneeId: main.userId, unreadCount: 0 });
    const msgs = await messagesOf(main.orgId, conversationId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "event", direction: "internal", body: `${names.marina} iniciou a conversa` });
    expect(msgs.some((m) => m.direction === "out")).toBe(false); // nada foi enviado ao cliente

    // tempo real: só ids, depois do commit
    const events = take();
    expect(events.map((e) => e.event.type).sort()).toEqual(["conversation.message", "conversation.updated", "home.invalidate"].sort());
    expect(events.find((e) => e.event.type === "conversation.updated")?.event).toMatchObject({ conversationId, reason: "other" });
    expect(events.every((e) => e.organizationId === main.orgId)).toBe(true);

    // segunda chamada: a mesma conversa, sem duplicar
    const again = await call("owner", { contactId: contact });
    expect(again.status).toBe(200);
    expect((await json<{ conversationId: string }>(again)).conversationId).toBe(conversationId);
    expect(await convsOf(main.orgId, contact)).toHaveLength(1);
    expect(await messagesOf(main.orgId, conversationId)).toHaveLength(1);
    expect(take()).toHaveLength(0); // abrir uma já existente não avisa ninguém
  });

  it("conversa aberta existente (aberta pelo cliente, de qualquer estado) é devolvida sem mudar nada", async () => {
    const contact = await newContact(main.orgId);
    const id = uuidv7();
    await withOrg(db, main.orgId, (tx) =>
      tx.insert(schema.conversations).values({ id, organizationId: main.orgId, contactId: contact, channelId: chan, status: "ai_active", mode: "ai", unreadCount: 3 }),
    );
    const res = await call("owner", { contactId: contact });
    expect(res.status).toBe(200);
    expect((await json<{ conversationId: string }>(res)).conversationId).toBe(id);
    const [conv] = await convsOf(main.orgId, contact);
    expect(conv).toMatchObject({ status: "ai_active", mode: "ai", unreadCount: 3, assigneeId: null });
  });

  it("conversa aberta SEM canal (canal apagado) passa a usar o canal conectado", async () => {
    const contact = await newContact(main.orgId);
    const id = uuidv7();
    await withOrg(db, main.orgId, (tx) =>
      tx.insert(schema.conversations).values({ id, organizationId: main.orgId, contactId: contact, channelId: null, status: "human_active", mode: "human", assigneeId: main.userId }),
    );
    expect((await json<{ conversationId: string }>(await call("owner", { contactId: contact }))).conversationId).toBe(id);
    expect((await convsOf(main.orgId, contact))[0]?.channelId).toBe(chan);
  });

  it("resolvida dentro da janela de reabertura: reabre a MESMA conversa, com a pessoa como responsável; fora da janela: cria outra", async () => {
    const contact = await newContact(main.orgId);
    const old = uuidv7();
    await withOrg(db, main.orgId, (tx) =>
      tx.insert(schema.conversations).values({
        id: old,
        organizationId: main.orgId,
        contactId: contact,
        channelId: chan,
        status: "resolved",
        mode: "human",
        resolvedBy: "human",
        resolvedAt: new Date(Date.now() - 2 * 86_400_000),
        assigneeId: main.members.agente!.userId,
      }),
    );
    take();
    const res = await call("owner", { contactId: contact });
    expect(res.status).toBe(200);
    expect((await json<{ conversationId: string }>(res)).conversationId).toBe(old);
    const [conv] = await convsOf(main.orgId, contact);
    expect(conv).toMatchObject({ id: old, status: "human_active", assigneeId: main.userId, resolvedAt: null, resolvedBy: null });
    expect((await messagesOf(main.orgId, old)).map((m) => m.body)).toContain(`${names.marina} reabriu a conversa`);
    const events = take();
    expect(events.find((e) => e.event.type === "conversation.updated")?.event).toMatchObject({ conversationId: old, reason: "reopened" });
    expect(events.some((e) => e.event.type === "home.invalidate")).toBe(true);

    // resolvida há 30 dias (fora da janela de 7): abre outra
    const stale = await newContact(main.orgId);
    const staleOld = uuidv7();
    await withOrg(db, main.orgId, (tx) =>
      tx.insert(schema.conversations).values({
        id: staleOld,
        organizationId: main.orgId,
        contactId: stale,
        channelId: chan,
        status: "resolved",
        resolvedBy: "human",
        resolvedAt: new Date(Date.now() - 30 * 86_400_000),
      }),
    );
    const fresh = await json<{ conversationId: string }>(await call("owner", { contactId: stale }));
    expect(fresh.conversationId).not.toBe(staleOld);
    const all = await convsOf(main.orgId, stale);
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === staleOld)?.status).toBe("resolved");
    expect(all.find((c) => c.id === fresh.conversationId)?.status).toBe("human_active");
  });

  it("cliente sem WhatsApp e cliente que recusou mensagens PODEM ter a conversa aberta (o envio é que obedece às regras)", async () => {
    const noPhone = await newContact(main.orgId, { phone: null, email: `sem-fone-${run}@example.test` });
    expect((await call("owner", { contactId: noPhone })).status).toBe(200);
    expect(await convsOf(main.orgId, noPhone)).toHaveLength(1);

    const denied = await newContact(main.orgId);
    await withOrg(db, main.orgId, (tx) => tx.insert(schema.consents).values({ id: uuidv7(), organizationId: main.orgId, contactId: denied, status: "denied", method: "conversation" }));
    expect((await call("owner", { contactId: denied })).status).toBe(200);
    expect(await convsOf(main.orgId, denied)).toHaveLength(1);
  });

  it("atendente (sem ver tudo): abre a própria conversa; conversa aberta de OUTRA pessoa responde 409 in_service sem entregar o id", async () => {
    const mine = await newContact(main.orgId);
    const res = await call("agente", { contactId: mine });
    expect(res.status).toBe(200);
    const { conversationId } = await json<{ conversationId: string }>(res);
    expect((await convsOf(main.orgId, mine))[0]).toMatchObject({ id: conversationId, assigneeId: main.members.agente!.userId });

    const theirs = await newContact(main.orgId);
    const owned = uuidv7();
    await withOrg(db, main.orgId, (tx) =>
      tx.insert(schema.conversations).values({ id: owned, organizationId: main.orgId, contactId: theirs, channelId: chan, status: "human_active", mode: "human", assigneeId: main.userId }),
    );
    const blocked = await call("agente", { contactId: theirs });
    expect(blocked.status).toBe(409);
    const body = await json(blocked);
    expect(body.error.code).toBe("in_service");
    expect(JSON.stringify(body)).not.toContain(owned);
    // quem enxerga tudo (dono) abre normalmente
    expect((await json<{ conversationId: string }>(await call("owner", { contactId: theirs }))).conversationId).toBe(owned);
  });

  it("corrida: várias chamadas ao mesmo tempo criam UMA conversa e todas recebem o mesmo id (pela rota e pelo serviço)", async () => {
    const viaRoute = await newContact(main.orgId);
    const responses = await Promise.all(Array.from({ length: 6 }, () => call("owner", { contactId: viaRoute })));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    const ids = new Set((await Promise.all(responses.map((r) => json<{ conversationId: string }>(r)))).map((b) => b.conversationId));
    expect(ids.size).toBe(1);
    expect(await convsOf(main.orgId, viaRoute)).toHaveLength(1);
    expect(await messagesOf(main.orgId, [...ids][0]!)).toHaveLength(1); // só um "iniciou a conversa"

    const viaService = await newContact(main.orgId);
    const actor: ConvCtx = { organizationId: main.orgId, userId: main.userId, userName: names.marina, timeZone: "America/Sao_Paulo", orgName: "x", canViewAll: true, sendingPaused: false };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => withOrgRealtime(db, main.orgId, (tx) => openConversationForContact(tx, main.orgId, actor, viaService, { reopenWindowDays: 7 }))),
    );
    const outcomes = results.map((r) => (r.ok ? r.data.outcome : r.error));
    expect(outcomes.filter((o) => o === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "existing")).toHaveLength(4);
    expect(new Set(results.map((r) => (r.ok ? r.data.conversationId : ""))).size).toBe(1);
    expect(await convsOf(main.orgId, viaService)).toHaveLength(1);
  });

  it("corrida com a entrada de mensagem: o índice único impede duas abertas e a perdedora relê a vencedora", async () => {
    const contact = await newContact(main.orgId);
    const actor: ConvCtx = { organizationId: main.orgId, userId: main.userId, userName: names.marina, timeZone: "America/Sao_Paulo", orgName: "x", canViewAll: true, sendingPaused: false };
    const rival = withOrg(db, main.orgId, (tx) =>
      tx
        .insert(schema.conversations)
        .values({ id: uuidv7(), organizationId: main.orgId, contactId: contact, channelId: chan, status: "ai_active", mode: "human" })
        .onConflictDoNothing()
        .returning(),
    );
    const [, opened] = await Promise.all([rival, withOrgRealtime(db, main.orgId, (tx) => openConversationForContact(tx, main.orgId, actor, contact))]);
    expect(opened.ok).toBe(true);
    const open = (await convsOf(main.orgId, contact)).filter((c) => c.status !== "resolved");
    expect(open).toHaveLength(1);
  });

  it("nenhum evento em tempo real carrega nome, telefone ou texto", async () => {
    const needles = [names.marina, names.rafael, "Cliente Sigiloso", "iniciou a conversa", "+5567"];
    for (const text of raw) for (const needle of needles) expect(text).not.toContain(needle);
    expect(raw.length).toBeGreaterThan(0);
  });

  it("não deixa conversa aberta duplicada em nenhum contato da empresa de teste", async () => {
    const rows = await withOrg(db, main.orgId, (tx) =>
      tx.select({ contactId: schema.conversations.contactId }).from(schema.conversations).where(and(eq(schema.conversations.organizationId, main.orgId), ne(schema.conversations.status, "resolved"))),
    );
    const seen = new Set<string>();
    for (const r of rows) {
      expect(seen.has(r.contactId)).toBe(false);
      seen.add(r.contactId);
    }
  });
});
