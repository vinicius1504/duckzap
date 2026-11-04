import { createFakeLlm, type GenerateRequest, type LLMProvider } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import { ProviderError, type ChannelRef, type MessagingProvider, type ProviderNumberCheck } from "../../lib/messaging";
import { setRealtimePublisher } from "../../lib/realtime";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadChannelsConfig } from "../channels/config";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { loadConversationsConfig } from "./config";
import { handleInbound } from "./inbound";
import { NO_WHATSAPP_MESSAGE } from "./number-check";
import { runDueAiTurn } from "./ai-turn";
import { conversationsRoutes } from "./routes";
import { createConversationsRuntime } from "./runtime";

/**
 * INTEGRAÇÃO — ações de chat no provedor: "visto azul" (marcar como lida) e "este número tem WhatsApp?" ao abrir conversa.
 * Banco descartável (NUNCA o `duckzap`):
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=… DATABASE_ADMIN_URL=… npx vitest run src/modules/conversations/chat-actions
 * O provedor é um dublê injetado que só anota o que receberia; nenhuma chamada de rede.
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
let seq = 0;
const extId = () => `ext-chat-${run}-${++seq}`;

type ReadCall = { ref: ChannelRef; to: string; messageIds: string[] };
type CheckCall = { ref: ChannelRef; numbers: string[] };

function fakeProvider() {
  const reads: ReadCall[] = [];
  const checks: CheckCall[] = [];
  const control = {
    hasMarkAsRead: true,
    hasCheckNumbers: true,
    failRead: false,
    failCheck: false,
    /** Resposta da conferência: por padrão o número existe. */
    answer: (numbers: string[]): ProviderNumberCheck[] => numbers.map((number) => ({ number, exists: true, jid: `${number}@s.whatsapp.net` })),
  };
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async () => ({ ok: true, providerMessageId: `prov-chat-${run}-${++seq}` }),
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
  };
  // as capacidades opcionais podem ser "desligadas" por teste (provedor que não sabe fazer)
  Object.defineProperty(provider, "markAsRead", { get: () => (control.hasMarkAsRead ? markAsRead : undefined), configurable: true });
  Object.defineProperty(provider, "checkNumbers", { get: () => (control.hasCheckNumbers ? checkNumbers : undefined), configurable: true });
  const markAsRead = async (ref: ChannelRef, input: { to: string; messageIds: string[] }) => {
    reads.push({ ref, ...input });
    if (control.failRead) throw new ProviderError("unavailable", "Evolution fora do ar (telefone 5567999990000)");
  };
  const checkNumbers = async (ref: ChannelRef, input: { numbers: string[] }) => {
    checks.push({ ref, numbers: input.numbers });
    if (control.failCheck) throw new ProviderError("unavailable", "Evolution fora do ar");
    return control.answer(input.numbers);
  };
  return { provider, reads, checks, control };
}

describe.skipIf(!enabled)("Ações de chat no provedor (integração)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const fake = fakeProvider();
  const jobs: Promise<void>[] = [];
  const flush = async () => {
    await Promise.all(jobs.splice(0));
  };
  const logs: { message: string; meta?: unknown }[] = [];
  let clock = new Date();
  const channelsRt = createChannelsRuntime({
    config: loadChannelsConfig({ CHANNELS_SEND_BURST_QR: "100", CHANNELS_SEND_PER_SECOND_QR: "100" }),
    providers: { get: () => fake.provider, kinds: () => ["evolution"] },
    now: () => clock,
    background: (task) => {
      jobs.push(task().catch(() => {}));
    },
    log: { warn: (message, meta) => void logs.push({ message, meta }), error: (message, meta) => void logs.push({ message, meta }) },
  });
  // a IA envia pelo runtime compartilhado de canais (mesmo dublê)
  setChannelsRuntime(channelsRt);

  // IA mínima: o roteador diz "pergunta" e o agente responde um texto fixo
  const llm: LLMProvider = {
    name: "roteirizado",
    async generate(request: GenerateRequest) {
      const base = { text: "", toolCalls: [], stopReason: "end" as const, usage: { inputTokens: 10, outputTokens: 5 }, model: "roteirizado", provider: "roteirizado" };
      if (request.meta?.purpose === "agent_router") return { ...base, text: JSON.stringify({ intent: "question", confidence: 0.9 }) };
      return { ...base, text: "Olá! Já te ajudo." };
    },
  };

  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const rt = createConversationsRuntime({ db, llm }, { config, now: () => new Date(), scheduleAiTurn: () => {}, register: false, channels: () => channelsRt });
  rt.ai.sleep = async () => {};
  rt.ai.log = { warn: () => {}, error: () => {} };

  const app = new OpenAPIHono();
  app.route("/v1", conversationsRoutes(deps, { config, now: () => new Date(), scheduleAiTurn: () => {}, register: false, channels: () => channelsRt }));
  app.onError(onError);
  const post = (as: string | null, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method: "POST",
      headers: { ...(as ? { "x-test-user": as } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const markRead = (as: string | null, id: string) => post(as, `/conversations/${id}/read`);
  const open = (as: string | null, contactId: string) => post(as, "/conversations/open", { contactId });
  const json = async <T = Record<string, any>>(res: Response) => (await res.json()) as T;

  setRealtimePublisher(() => {});
  afterAll(() => setRealtimePublisher(null));

  let main: SecondOrg; // canal Evolution + agente
  let other: SecondOrg;
  const ids = { chan: uuidv7(), chanOff: uuidv7(), chanOther: uuidv7(), agent: uuidv7() };

  async function insertChannel(org: string, id: string, over: Partial<typeof schema.channels.$inferInsert> = {}) {
    await withOrg(db, org, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: org,
        name: `Canal ${run}`,
        type: "whatsapp_qr",
        provider: "evolution",
        status: "connected",
        address: "+556733330000",
        webhookTokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
        webhookTokenEnc: encryptSecret(org, "token"),
        ...over,
      }),
    );
  }

  beforeAll(async () => {
    main = await createSecondOrg("chat", { planSlug: "empresarial", ownerName: "Marina Alves" });
    other = await createSecondOrg("chat-outra");
    sessions.owner = { user: { id: main.userId, name: "Marina Alves", email: main.userEmail }, session: { id: "c1", activeOrganizationId: main.orgId } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "c2", activeOrganizationId: other.orgId } };
    // o canal Evolution é o primeiro (padrão de "abrir conversa"); o oficial existe só para o teste de "canal sem a capacidade"
    await insertChannel(main.orgId, ids.chan);
    await insertChannel(main.orgId, ids.chanOff, { name: `Oficial ${run}`, type: "whatsapp_official", provider: "meta_cloud", isDefault: false });
    await insertChannel(other.orgId, ids.chanOther);
    await withOrg(db, main.orgId, async (tx) => {
      await tx.insert(schema.agents).values({ id: ids.agent, organizationId: main.orgId, job: "support", status: "active", currentVersion: 1 });
      await tx.insert(schema.agentVersions).values({
        id: uuidv7(),
        organizationId: main.orgId,
        agentId: ids.agent,
        number: 1,
        summary: "teste",
        createdBy: main.userId,
        config: {
          name: "Agente Duck",
          profile: { description: "Atende a loja", tone: "friendly", companySummary: "Loja Alvorada" },
          knowledge: { productsAndServices: "Roupas.", faq: "Atendemos de segunda a sábado." },
          behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
          followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
          scheduling: { canBook: false, appointmentTypeIds: [] },
          advanced: { prompt: "", tools: ["search_knowledge", "request_human"] },
        },
      });
    });
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
  });
  afterEach(() => {
    fake.control.hasMarkAsRead = true;
    fake.control.hasCheckNumbers = true;
    fake.control.failRead = false;
    fake.control.failCheck = false;
    fake.control.answer = (numbers) => numbers.map((number) => ({ number, exists: true, jid: `${number}@s.whatsapp.net` }));
    fake.reads.length = 0;
    fake.checks.length = 0;
    logs.length = 0;
    clock = new Date();
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  async function inbound(org: SecondOrg, channelId: string, from: string, text = "Oi, tudo bem?") {
    const externalId = extId();
    await handleInbound(rt.inbound, { organizationId: org.orgId, channelId, event: { type: "message", externalId, from, name: "Cliente", kind: "text", text, at: new Date().toISOString() } });
    return externalId;
  }
  async function conversationOf(org: SecondOrg, from: string) {
    return withOrg(db, org.orgId, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, org.orgId), eq(schema.contacts.phone, from)));
      const [conv] = await tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, contact!.id));
      return conv!;
    });
  }
  /** Conversa nova com `count` mensagens do cliente; devolve os ids do provedor na ordem. */
  async function newConversation(count = 1, org: SecondOrg = main, channelId = ids.chan) {
    const from = phone();
    const externalIds: string[] = [];
    for (let i = 0; i < count; i++) externalIds.push(await inbound(org, channelId, from, `mensagem ${i + 1}`));
    return { from, externalIds, conv: await conversationOf(org, from) };
  }
  const inboundRows = (org: SecondOrg, conversationId: string) =>
    withOrg(db, org.orgId, (tx) =>
      tx
        .select({ externalId: schema.messages.externalId, readAt: schema.messages.readAt })
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "in")))
        .orderBy(schema.messages.createdAt, schema.messages.id),
    );
  const patchConv = (org: SecondOrg, id: string, patch: Partial<typeof schema.conversations.$inferInsert>) =>
    withOrg(db, org.orgId, (tx) => tx.update(schema.conversations).set(patch).where(eq(schema.conversations.id, id)));
  const newContact = async (org: SecondOrg, over: Partial<typeof schema.contacts.$inferInsert> = {}) => {
    const id = uuidv7();
    const p = phone();
    await withOrg(db, org.orgId, (tx) => tx.insert(schema.contacts).values({ id, organizationId: org.orgId, name: `Cliente ${run}-${id.slice(-6)}`, phone: p, ...over }));
    return { id, phone: p };
  };
  const conversationsOf = (org: SecondOrg, contactId: string) =>
    withOrg(db, org.orgId, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, contactId)));

  // ── visto azul ─────────────────────────────────────────────────────────────
  describe("marcar como lida (POST /conversations/:id/read)", () => {
    it("a equipe abre a conversa: o provedor recebe os ids das recebidas (telefone do contato, canal da conversa) e elas são carimbadas", async () => {
      const { conv, from, externalIds } = await newConversation(2);
      expect(conv.unreadCount).toBe(2);
      const res = await markRead("owner", conv.id);
      expect(res.status).toBe(200);
      await flush();

      expect(fake.reads).toHaveLength(1);
      expect(fake.reads[0]).toMatchObject({ to: from, messageIds: externalIds });
      expect(fake.reads[0]!.ref.id).toBe(ids.chan);
      expect(fake.reads[0]!.ref.organizationId).toBe(main.orgId);
      const rows = await inboundRows(main, conv.id);
      expect(rows.every((r) => r.readAt !== null)).toBe(true);
      expect((await conversationOf(main, from)).unreadCount).toBe(0);
    });

    it("só uma vez: chamadas repetidas não marcam a mesma coisa de novo; mensagem nova marca só a nova", async () => {
      const { conv, from, externalIds } = await newConversation(1);
      await markRead("owner", conv.id);
      await flush();
      await markRead("owner", conv.id);
      await markRead("owner", conv.id);
      await flush();
      expect(fake.reads).toHaveLength(1);

      const fresh = await inbound(main, ids.chan, from, "ainda aí?");
      await markRead("owner", conv.id);
      await flush();
      expect(fake.reads).toHaveLength(2);
      expect(fake.reads[1]!.messageIds).toEqual([fresh]);
      expect(externalIds).not.toContain(fresh);
    });

    it("manda só as mais recentes (no máximo 20) e carimba também as antigas que ficaram de fora", async () => {
      const { conv } = await newConversation(23);
      await markRead("owner", conv.id);
      await flush();
      expect(fake.reads).toHaveLength(1);
      expect(fake.reads[0]!.messageIds).toHaveLength(20);
      expect((await inboundRows(main, conv.id)).every((r) => r.readAt !== null)).toBe(true);
      await markRead("owner", conv.id);
      await flush();
      expect(fake.reads).toHaveLength(1);
    });

    it("erro do provedor nunca quebra a requisição nem o atendimento: 200, não lidas zeradas, nada carimbado, log sem dado pessoal; a próxima abertura tenta de novo", async () => {
      const { conv, from } = await newConversation(1);
      fake.control.failRead = true;
      const res = await markRead("owner", conv.id);
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ ok: true });
      await flush();
      expect(fake.reads).toHaveLength(1);
      expect((await conversationOf(main, from)).unreadCount).toBe(0);
      expect((await inboundRows(main, conv.id))[0]!.readAt).toBeNull();
      const logged = JSON.stringify(logs);
      expect(logged).toContain("conversations.read_receipt.failed");
      expect(logged).not.toContain("5567");
      expect(logged).not.toContain(from);

      fake.control.failRead = false;
      await markRead("owner", conv.id);
      await flush();
      expect(fake.reads).toHaveLength(2);
      expect((await inboundRows(main, conv.id))[0]!.readAt).not.toBeNull();
    });

    it("provedor sem markAsRead, canal que não é WhatsApp-Evolution, desconectado, conversa sem canal ou plano suspenso: não faz nada (200)", async () => {
      // provedor que não sabe marcar
      const a = await newConversation(1);
      fake.control.hasMarkAsRead = false;
      expect((await markRead("owner", a.conv.id)).status).toBe(200);
      await flush();
      expect(fake.reads).toHaveLength(0);
      expect((await inboundRows(main, a.conv.id))[0]!.readAt).toBeNull();
      fake.control.hasMarkAsRead = true;

      // canal oficial (não é QR)
      const b = await newConversation(1, main, ids.chanOff);
      expect(b.conv.channelId).toBe(ids.chanOff);
      await markRead("owner", b.conv.id);
      await flush();
      expect(fake.reads).toHaveLength(0);

      // conversa sem canal (existe `channel_id is null`)
      const c = await newConversation(1);
      await patchConv(main, c.conv.id, { channelId: null });
      await markRead("owner", c.conv.id);
      await flush();
      expect(fake.reads).toHaveLength(0);

      // canal desconectado
      const d = await newConversation(1);
      await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ status: "disconnected" }).where(eq(schema.channels.id, ids.chan)));
      try {
        await markRead("owner", d.conv.id);
        await flush();
        expect(fake.reads).toHaveLength(0);
      } finally {
        await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ status: "connected" }).where(eq(schema.channels.id, ids.chan)));
      }

      // plano com envio pausado (relógio além do vencimento)
      const e = await newConversation(1);
      clock = new Date(Date.now() + 90 * 86_400_000);
      await markRead("owner", e.conv.id);
      await flush();
      expect(fake.reads).toHaveLength(0);
    });

    it("mensagem antiga (mais de 7 dias) não acende visto: nada é enviado", async () => {
      const { conv } = await newConversation(1);
      await withOrg(db, main.orgId, (tx) =>
        tx.update(schema.messages).set({ createdAt: new Date(Date.now() - 10 * 86_400_000) }).where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, "in"))),
      );
      await markRead("owner", conv.id);
      await flush();
      expect(fake.reads).toHaveLength(0);
    });

    it("conversa de outra empresa, inexistente ou sem sessão: 404/401 e o provedor não é chamado", async () => {
      const { conv } = await newConversation(1);
      expect((await markRead("other", conv.id)).status).toBe(404);
      expect((await markRead("owner", uuidv7())).status).toBe(404);
      expect((await markRead(null, conv.id)).status).toBe(401);
      await flush();
      expect(fake.reads).toHaveLength(0);
    });
  });

  describe("a IA responde ao cliente", () => {
    it("marca como lidas as recebidas do turno, depois de responder (uma vez)", async () => {
      const from = phone();
      await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ agentId: ids.agent }).where(eq(schema.channels.id, ids.chan)));
      try {
        const first = await inbound(main, ids.chan, from, "Vocês abrem sábado?");
        const second = await inbound(main, ids.chan, from, "E domingo?");
        const conv = await conversationOf(main, from);
        // o prazo de rajada é zerado no teste: o turno está vencido
        await patchConv(main, conv.id, { aiDueAt: new Date(Date.now() - 1000) });
        const report = await runDueAiTurn(rt.ai, rt.limiters, main.orgId, conv.id);
        expect(report.mode).toBe("live");
        expect(report.sent).toBeGreaterThan(0);
        await flush();

        expect(fake.reads).toHaveLength(1);
        expect(fake.reads[0]).toMatchObject({ to: from, messageIds: [first, second] });
        expect((await inboundRows(main, conv.id)).every((r) => r.readAt !== null)).toBe(true);

        // depois a equipe abre a conversa: as recebidas já estão marcadas, nada novo vai ao provedor
        await markRead("owner", conv.id);
        await flush();
        expect(fake.reads).toHaveLength(1);
      } finally {
        await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ agentId: null }).where(eq(schema.channels.id, ids.chan)));
      }
    });

    it("erro do provedor ao marcar não afeta a resposta da IA", async () => {
      const from = phone();
      await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ agentId: ids.agent }).where(eq(schema.channels.id, ids.chan)));
      try {
        await inbound(main, ids.chan, from, "Tem horário amanhã?");
        const conv = await conversationOf(main, from);
        await patchConv(main, conv.id, { aiDueAt: new Date(Date.now() - 1000) });
        fake.control.failRead = true;
        const report = await runDueAiTurn(rt.ai, rt.limiters, main.orgId, conv.id);
        expect(report.sent).toBeGreaterThan(0);
        await flush();
        expect(fake.reads).toHaveLength(1);
        const out = await withOrg(db, main.orgId, (tx) =>
          tx.select({ status: schema.messages.status }).from(schema.messages).where(and(eq(schema.messages.conversationId, conv.id), eq(schema.messages.direction, "out"))),
        );
        expect(out.length).toBeGreaterThan(0);
        expect(out.every((m) => m.status === "sent")).toBe(true);
      } finally {
        await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ agentId: null }).where(eq(schema.channels.id, ids.chan)));
      }
    });
  });

  // ── número sem WhatsApp ────────────────────────────────────────────────────
  describe("abrir conversa (POST /conversations/open) confere o número", () => {
    it("o provedor diz que o número NÃO tem WhatsApp: erro claro em pt-BR e nenhuma conversa é criada", async () => {
      const contact = await newContact(main);
      fake.control.answer = (numbers) => numbers.map((number) => ({ number, exists: false, jid: null }));
      const res = await open("owner", contact.id);
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body.error.code).toBe("no_whatsapp");
      expect(body.error.message).toBe(NO_WHATSAPP_MESSAGE);
      expect(NO_WHATSAPP_MESSAGE).toBe("Este número não tem WhatsApp.");
      expect(fake.checks).toHaveLength(1);
      expect(fake.checks[0]!.numbers).toEqual([contact.phone.replace(/\D/g, "")]);
      expect(fake.checks[0]!.ref.id).toBe(ids.chan);
      expect(await conversationsOf(main, contact.id)).toHaveLength(0);
    });

    it("o número tem WhatsApp: abre normalmente (mesmo que o jid venha com outro número)", async () => {
      const contact = await newContact(main);
      fake.control.answer = (numbers) => numbers.map((number) => ({ number, exists: true, jid: "556799990000@s.whatsapp.net" }));
      const res = await open("owner", contact.id);
      expect(res.status).toBe(200);
      expect(fake.checks).toHaveLength(1);
      expect(await conversationsOf(main, contact.id)).toHaveLength(1);
    });

    it("erro, lentidão ou resposta inesperada do provedor NÃO bloqueia: abre normalmente e registra só o tipo do erro", async () => {
      const contact = await newContact(main);
      fake.control.failCheck = true;
      const res = await open("owner", contact.id);
      expect(res.status).toBe(200);
      expect(fake.checks).toHaveLength(1);
      expect(JSON.stringify(logs)).toContain("conversations.number_check.failed");
      expect(JSON.stringify(logs)).not.toContain(contact.phone.replace(/\D/g, ""));

      const other2 = await newContact(main);
      fake.control.failCheck = false;
      fake.control.answer = () => []; // o provedor não devolveu nada sobre o número
      expect((await open("owner", other2.id)).status).toBe(200);
    });

    it("provedor sem checkNumbers (ou canal que não é WhatsApp-Evolution): não confere e abre", async () => {
      const contact = await newContact(main);
      fake.control.hasCheckNumbers = false;
      expect((await open("owner", contact.id)).status).toBe(200);
      expect(fake.checks).toHaveLength(0);
    });

    it("quem já escreveu para a empresa ou já tem conversa aberta não gasta consulta", async () => {
      // já escreveu (tem recebida), mesmo com a conversa resolvida
      const { conv, from } = await newConversation(1);
      await patchConv(main, conv.id, { status: "resolved", resolvedAt: new Date(Date.now() - 30 * 86_400_000) });
      const [contact] = await withOrg(db, main.orgId, (tx) => tx.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.phone, from)));
      fake.control.answer = (numbers) => numbers.map((number) => ({ number, exists: false, jid: null }));
      expect((await open("owner", contact!.id)).status).toBe(200);
      expect(fake.checks).toHaveLength(0);

      // já tem conversa aberta: "abrir" só devolve o id dela
      expect((await open("owner", contact!.id)).status).toBe(200);
      expect(fake.checks).toHaveLength(0);
    });

    it("cliente de outra empresa ou inexistente continua 404, sem chamar o provedor", async () => {
      const foreign = await newContact(other);
      expect((await open("owner", foreign.id)).status).toBe(404);
      expect((await open("owner", uuidv7())).status).toBe(404);
      expect(fake.checks).toHaveLength(0);
    });

    it("sem canal Evolution conectado (só o oficial): não confere", async () => {
      const lonely = await createSecondOrg("chat-oficial", { planSlug: "empresarial" });
      sessions.lonely = { user: { id: lonely.userId, name: lonely.userName, email: lonely.userEmail }, session: { id: "c3", activeOrganizationId: lonely.orgId } };
      try {
        await insertChannel(lonely.orgId, uuidv7(), { type: "whatsapp_official", provider: "meta_cloud" });
        const contact = await newContact(lonely);
        fake.control.answer = (numbers) => numbers.map((number) => ({ number, exists: false, jid: null }));
        const res = await open("lonely", contact.id);
        expect(res.status).not.toBe(422);
        expect(fake.checks).toHaveLength(0);
      } finally {
        await lonely.remove();
      }
    });
  });
});
