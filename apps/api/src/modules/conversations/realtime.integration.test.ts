import { createFakeLlm } from "@duckzap/ai";
import type { RealtimeEnvelope } from "@duckzap/contracts/realtime";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import type { InboundEvent, MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { typingMsForText } from "../../lib/presence";
import { queueRealtime, setRealtimePublisher, withOrgRealtime } from "../../lib/realtime";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { appointmentsRoutes } from "../appointments/routes";
import { processInbound, recordInbound } from "../channels/inbound-store";
import { loadChannelsConfig } from "../channels/config";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { suspendOrganization } from "../channels/suspension";
import { homeRoutes } from "../home/routes";
import { closeInactiveAiConversations, runDueAiTurn } from "./ai-turn";
import { loadConversationsConfig } from "./config";
import { handleInbound } from "./inbound";
import { conversationsRoutes } from "./routes";
import { activateConversations, createConversationsRuntime } from "./runtime";
import { assumeConversation } from "./service";

/**
 * INTEGRAÇÃO — publicação em tempo real (apps/api/src/lib/realtime.ts) nos pontos de gravação.
 * Banco descartável (NUNCA o `duckzap`), mesmas flags dos outros testes de integração:
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=… DATABASE_ADMIN_URL=… npx vitest run src/modules/conversations/realtime
 * O publicador é falso (`setRealtimePublisher`): nada vai ao Valkey. O que se confere aqui:
 *  - o evento certo sai, para a empresa certa e só para ela;
 *  - sai DEPOIS do commit (nunca de dentro da transação, nunca se ela falhar);
 *  - nenhum evento carrega texto de mensagem, nome ou telefone.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CONVERSATIONS_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

let A = "";
let OWNER = "";
let AGENT = "";
const run = Math.random().toString(36).slice(2, 8);
const phone = () => `+55679${randomInt(10_000_000, 99_999_999)}`;
let seq = 0;
const extId = (label = "m") => `ext-rt-${run}-${label}-${++seq}`;

function fakeMessaging() {
  const sent: OutboundMessage[] = [];
  let n = 0;
  const control = { failNext: false };
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: true }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (_channel, message) => {
      if (control.failNext) {
        control.failNext = false;
        return { ok: false, code: "rejected", message: "recusado pelo provedor de teste" };
      }
      sent.push(message);
      return { ok: true, providerMessageId: `prov-rt-${run}-${++n}` };
    },
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
  };
  return { provider, sent, control };
}

describe.skipIf(!enabled)("Tempo real — pontos de publicação (integração)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const messaging = fakeMessaging();
  const channelsConfig = loadChannelsConfig({ CHANNELS_SEND_BURST_QR: "100", CHANNELS_SEND_PER_SECOND_QR: "100" });
  setChannelsRuntime(
    createChannelsRuntime({
      config: channelsConfig,
      providers: { get: () => messaging.provider, kinds: () => ["evolution"] },
      sendLimiterFor: () => new InMemoryTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
    }),
  );
  const channelsRt = createChannelsRuntime({ config: channelsConfig, providers: { get: () => messaging.provider, kinds: () => ["evolution"] } });

  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const rt = createConversationsRuntime(deps, { config, now: () => new Date(), scheduleAiTurn: () => {}, register: false });

  const app = new OpenAPIHono();
  app.route("/v1", conversationsRoutes(deps, { config, now: () => new Date(), scheduleAiTurn: () => {}, register: false }));
  app.route("/v1", homeRoutes(deps));
  app.route("/v1", appointmentsRoutes(deps));
  app.onError(onError);
  const call = async (as: string, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { "x-test-user": as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

  // ── captura ────────────────────────────────────────────────────────────────
  let captured: RealtimeEnvelope[] = [];
  const raw: string[] = [];
  setRealtimePublisher((envelope) => {
    captured.push(envelope);
    raw.push(JSON.stringify(envelope));
  });
  afterAll(() => setRealtimePublisher(null));
  /** Pega o que foi publicado desde a última chamada. */
  const take = () => {
    const out = captured;
    captured = [];
    return out;
  };
  const typesOf = (list: RealtimeEnvelope[]) => list.map((e) => e.event.type);
  const find = (list: RealtimeEnvelope[], type: string, extra: Record<string, unknown> = {}) =>
    list.filter((e) => e.event.type === type && Object.entries(extra).every(([k, v]) => (e.event as Record<string, unknown>)[k] === v));

  // textos e telefones usados: nenhum pode aparecer em evento
  const sensitive: string[] = [];

  // ── fixtures ───────────────────────────────────────────────────────────────
  let main: SecondOrg;
  let other: SecondOrg;
  let suspendable: SecondOrg;
  const ids = { teamA: uuidv7(), teamB: uuidv7(), chan: uuidv7(), chanOther: uuidv7(), chanAuto: uuidv7(), agent: uuidv7(), type: uuidv7() };

  async function insertChannel(org: string, id: string, name: string, over: Partial<typeof schema.channels.$inferInsert> = {}) {
    await withOrg(db, org, (tx) =>
      tx.insert(schema.channels).values({
        id,
        organizationId: org,
        name,
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
    main = await createSecondOrg("rt", { planSlug: "empresarial", ownerName: "Marina Alves", extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("rt-outra");
    suspendable = await createSecondOrg("rt-suspensa");
    A = main.orgId;
    OWNER = main.userId;
    AGENT = main.members.agente!.userId;
    sessions.owner = { user: { id: OWNER, name: "Marina Alves", email: main.userEmail }, session: { id: "s1", activeOrganizationId: A } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s4", activeOrganizationId: other.orgId } };
    await withOrg(db, A, async (tx) => {
      const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: true, start: "00:00", end: "23:59" }));
      await tx.insert(schema.teams).values([
        { id: ids.teamA, organizationId: A, name: `Recepção ${run}`, color: "blue", priority: 1, businessHours: hours },
        { id: ids.teamB, organizationId: A, name: `Vendas ${run}`, color: "green", priority: 2, businessHours: hours },
      ]);
      await tx.insert(schema.teamMembers).values({ teamId: ids.teamA, organizationId: A, memberRef: AGENT });
    });
    await insertChannel(A, ids.chan, `Recepção ${run}`, { teamId: ids.teamA, welcomeMessage: "Olá! Bem-vindo à Casa Alvorada RT." });
    // canal em modo Automático (sem IA): é ele que envia as mensagens automáticas
    await insertChannel(A, ids.chanAuto, `Automático ${run}`, { teamId: ids.teamA, replyMode: "auto", welcomeMessage: "Olá! Bem-vindo à Casa Alvorada RT." });
    await insertChannel(other.orgId, ids.chanOther, `Outra ${run}`);
    await withOrg(db, A, async (tx) => {
      await tx.insert(schema.appointmentTypes).values({ id: ids.type, organizationId: A, name: `Avaliação ${run}`, durationMinutes: 30 });
      await tx.insert(schema.agents).values({ id: ids.agent, organizationId: A, job: "support", status: "active", currentVersion: 1 });
      await tx.update(schema.channels).set({ agentId: ids.agent }).where(eq(schema.channels.id, ids.chan));
      await tx.insert(schema.agentVersions).values({
        id: uuidv7(),
        organizationId: A,
        agentId: ids.agent,
        number: 1,
        summary: "teste",
        createdBy: OWNER,
        config: {
          name: "Agente Duck",
          profile: { description: "Atende a recepção", tone: "friendly", companySummary: "Casa Alvorada Odontologia" },
          knowledge: {
            productsAndServices: "Fazemos limpeza e clareamento.\nFazemos avaliação odontológica.",
            faq: "Atendemos de segunda a sexta.\nFicamos na Rua das Flores 100.",
          },
          behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 5 },
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
    await suspendable?.remove();
  });
  afterEach(() => {
    messaging.control.failNext = false;
  });

  // ── helpers ────────────────────────────────────────────────────────────────
  async function inbound(org: string, channelId: string, from: string, text: string, over: Partial<Extract<InboundEvent, { type: "message" }>> = {}) {
    sensitive.push(text, from);
    const event: InboundEvent = { type: "message", externalId: extId(), from, name: "Cliente Sigiloso", kind: "text", text, at: new Date().toISOString(), ...over };
    await handleInbound(rt.inbound, { organizationId: org, channelId, event });
    return event as Extract<InboundEvent, { type: "message" }>;
  }
  async function conversationOf(org: string, from: string, channelId = ids.chan) {
    return withOrg(db, org, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.phone, from)));
      if (!contact) return null;
      const [conv] = await tx.select().from(schema.conversations).where(and(eq(schema.conversations.contactId, contact.id), eq(schema.conversations.channelId, channelId)));
      return conv ? { conv, contact } : null;
    });
  }
  async function newConversation(text = "Oi, queria saber mais", options: { keepEvents?: boolean } = {}) {
    const from = phone();
    await inbound(A, ids.chan, from, text);
    const found = await conversationOf(A, from);
    if (!found) throw new Error("conversa não criada");
    if (!options.keepEvents) take();
    return { from, ...found };
  }

  // ── pipeline de entrada ────────────────────────────────────────────────────
  describe("mensagem recebida", () => {
    it("conversa nova: conversation.message(in) + conversation.updated + mensagem automática (out) e seu status, só para a empresa dona", async () => {
      take();
      const from = phone();
      await inbound(A, ids.chanAuto, from, "Mensagem sigilosa de entrada 111");
      const found = await conversationOf(A, from, ids.chanAuto);
      const events = take();
      const conversationId = found!.conv.id;

      expect(find(events, "conversation.message", { conversationId, direction: "in" })).toHaveLength(1);
      expect(find(events, "conversation.updated", { conversationId })).toHaveLength(1);
      // boas-vindas do canal: mensagem de saída + resultado do envio
      expect(find(events, "conversation.message", { conversationId, direction: "out" })).toHaveLength(1);
      const status = find(events, "message.status", { conversationId, status: "sent" });
      expect(status).toHaveLength(1);
      expect(events.every((e) => e.organizationId === A)).toBe(true);
      expect(events.every((e) => e.v === 1 && Boolean(e.id) && !Number.isNaN(Date.parse(e.at)))).toBe(true);
    });

    it("mensagem repetida (dedupe do provedor) não publica nada", async () => {
      const from = phone();
      const first = await inbound(A, ids.chan, from, "primeira");
      take();
      await handleInbound(rt.inbound, { organizationId: A, channelId: ids.chan, event: first });
      expect(take()).toEqual([]);
    });

    it("cliente volta a escrever numa conversa resolvida: conversation.updated(reopened) e home.invalidate", async () => {
      const { conv, from } = await newConversation("oi");
      expect((await call("owner", "POST", `/conversations/${conv.id}/resolve`)).status).toBe(200);
      take();
      await inbound(A, ids.chan, from, "mais uma dúvida");
      const events = take();
      expect(find(events, "conversation.updated", { conversationId: conv.id, reason: "reopened" })).toHaveLength(1);
      expect(find(events, "conversation.message", { conversationId: conv.id, direction: "in" })).toHaveLength(1);
      expect(find(events, "home.invalidate")).toHaveLength(1);
    });

    it("conversa sem agente cai na fila: conversation.updated(queue) + home.invalidate", async () => {
      // o canal da outra empresa não tem agente: Só humano, fila da equipe
      take();
      const from = phone();
      await inbound(other.orgId, ids.chanOther, from, "preciso de ajuda com o pedido");
      const events = take();
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.organizationId === other.orgId)).toBe(true);
      expect(find(events, "conversation.updated", { reason: "queue" })).toHaveLength(1);
      expect(find(events, "home.invalidate")).toHaveLength(1);
      // limpeza: a empresa é removida no afterAll
    });

    it("status de entrega (lida) vira message.status com o id da mensagem", async () => {
      activateConversations(rt); // o Canais despacha o evento para o handler das Conversas
      const { conv } = await newConversation("oi");
      const sent = await json<{ id: string }>(await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Resposta para status", attachment: null, clientId: `c-${run}-st` }));
      take();
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.id, sent.id)));
      const statusEvent: InboundEvent = { type: "status", externalId: row?.providerMessageId ?? "", status: "read", at: new Date().toISOString() };
      const rec = await recordInbound(db, { organizationId: A, channelId: ids.chan, rawBody: "{}", events: [statusEvent], parseFailed: false });
      await processInbound(db, A, channelsRt, { ids: rec.ids });
      const events = take();
      expect(find(events, "message.status", { conversationId: conv.id, messageId: sent.id, status: "read" })).toHaveLength(1);
      expect(events.every((e) => e.organizationId === A)).toBe(true);
    });
  });

  // ── ações da equipe ────────────────────────────────────────────────────────
  describe("ações sobre a conversa", () => {
    it("assumir, transferir, modo, resolver, reabrir, etapa, lida e follow-up publicam o motivo certo", async () => {
      const { conv, from } = await newConversation("oi");
      const reasons = async (call_: () => Promise<Response>, expected: number | null = 200) => {
        take();
        const res = await call_();
        if (expected) expect(res.status).toBe(expected);
        return take();
      };
      const updated = (events: RealtimeEnvelope[], reason: string) => find(events, "conversation.updated", { conversationId: conv.id, reason });

      let ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/assume`));
      expect(updated(ev, "assigned")).toHaveLength(1);
      expect(find(ev, "conversation.message", { conversationId: conv.id, direction: "internal" })).toHaveLength(1); // "Marina assumiu a conversa"

      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "member", memberId: AGENT }, note: "Nota interna sigilosa 222" }));
      sensitive.push("Nota interna sigilosa 222");
      expect(updated(ev, "transferred")).toHaveLength(1);

      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "team", teamId: ids.teamB }, note: null }));
      expect(updated(ev, "transferred")).toHaveLength(1);
      expect(find(ev, "home.invalidate")).toHaveLength(1); // entrou na fila

      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/mode`, { mode: "ai" }));
      expect(updated(ev, "mode")).toHaveLength(1);
      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/mode`, { mode: "ai" }));
      expect(ev).toEqual([]); // mesmo modo: nada mudou

      const lookups = await json<{ tags: { id: string; funnelStage: number | null }[] }>(await call("owner", "GET", "/inbox/lookups"));
      const stage = lookups.tags.find((t) => t.funnelStage === 3);
      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/stage`, { stageId: stage!.id }));
      expect(updated(ev, "stage")).toHaveLength(1);

      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/follow-up`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }));
      expect(updated(ev, "follow_up")).toHaveLength(1);
      ev = await reasons(() => call("owner", "PATCH", `/conversations/${conv.id}/follow-up`, { paused: true }));
      expect(updated(ev, "follow_up")).toHaveLength(1);
      ev = await reasons(() => call("owner", "DELETE", `/conversations/${conv.id}/follow-up`));
      expect(updated(ev, "follow_up")).toHaveLength(1);

      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/resolve`));
      expect(updated(ev, "resolved")).toHaveLength(1);
      expect(find(ev, "home.invalidate")).toHaveLength(1);

      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/reopen`));
      expect(updated(ev, "reopened")).toHaveLength(1);

      // lida: só publica quando havia mensagens não lidas
      await inbound(A, ids.chan, from, "nova mensagem não lida");
      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/read`));
      expect(updated(ev, "read")).toHaveLength(1);
      ev = await reasons(() => call("owner", "POST", `/conversations/${conv.id}/read`));
      expect(ev).toEqual([]); // já estava lida: nada mudou, nada a avisar
    });

    it("ação recusada (conflito/404) não publica nada", async () => {
      const { conv } = await newConversation("oi");
      await call("owner", "POST", `/conversations/${conv.id}/resolve`);
      take();
      expect((await call("owner", "POST", `/conversations/${conv.id}/assume`)).status).toBe(409);
      expect((await call("other", "POST", `/conversations/${conv.id}/resolve`)).status).toBe(404); // outra empresa
      expect((await call("owner", "POST", `/conversations/${uuidv7()}/assume`)).status).toBe(404);
      expect(take()).toEqual([]);
    });

    it("enviar mensagem: conversation.message(out) + message.status(sent); falha e reenvio: failed → sent; nota: internal", async () => {
      const { conv } = await newConversation("oi");
      sensitive.push("Resposta confidencial 333", "Nota confidencial 444");

      const res = await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Resposta confidencial 333", attachment: null, clientId: `c-${run}-1` });
      expect(res.status).toBe(201);
      const sent = await json<{ id: string }>(res);
      let ev = take();
      expect(find(ev, "conversation.message", { conversationId: conv.id, direction: "out" })).toHaveLength(1);
      expect(find(ev, "message.status", { conversationId: conv.id, messageId: sent.id, status: "sent" })).toHaveLength(1);
      expect(find(ev, "conversation.updated", { conversationId: conv.id, reason: "assigned" })).toHaveLength(1); // responder assume

      messaging.control.failNext = true;
      const failed = await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Resposta confidencial 333", attachment: null, clientId: `c-${run}-2` });
      const failedMsg = await json<{ id: string; status: string }>(failed);
      ev = take();
      expect(failedMsg.status).toBe("failed");
      expect(find(ev, "message.status", { conversationId: conv.id, messageId: failedMsg.id, status: "failed" })).toHaveLength(1);

      const resend = await call("owner", "POST", `/conversations/${conv.id}/messages/${failedMsg.id}/resend`);
      expect(resend.status).toBe(200);
      ev = take();
      expect(find(ev, "message.status", { conversationId: conv.id, messageId: failedMsg.id, status: "sent" })).toHaveLength(1);
      expect(find(ev, "conversation.message", { direction: "out" })).toHaveLength(0); // reenvio não é mensagem nova

      expect((await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "note", body: "Nota confidencial 444", attachment: null, clientId: `c-${run}-3` })).status).toBe(201);
      ev = take();
      expect(find(ev, "conversation.message", { conversationId: conv.id, direction: "internal" })).toHaveLength(1);
      expect(find(ev, "message.status")).toHaveLength(0);
    });
  });

  // ── depois do commit ───────────────────────────────────────────────────────
  describe("momento da publicação", () => {
    it("publica DEPOIS do commit (nada de dentro da transação) e o dado já está visível quando o evento sai", async () => {
      const { conv } = await newConversation("oi");
      const ctx = { organizationId: A, userId: OWNER, userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "", canViewAll: true, sendingPaused: false };
      let insideTx = -1;
      const seen: boolean[] = [];
      setRealtimePublisher((envelope) => {
        captured.push(envelope);
        raw.push(JSON.stringify(envelope));
        // roda numa conexão NOVA: só enxerga o que já foi confirmado
        seen.push(true);
        void withOrg(db, A, (tx) => tx.select({ status: schema.conversations.status, assignee: schema.conversations.assigneeId }).from(schema.conversations).where(eq(schema.conversations.id, conv.id))).then(([row]) => {
          seen[seen.length - 1] = row?.status === "human_active" && row.assignee === OWNER;
        });
      });
      try {
        await withOrgRealtime(db, A, async (tx) => {
          const result = await assumeConversation(tx, ctx, conv.id);
          expect(result.ok).toBe(true);
          insideTx = captured.length;
        });
        expect(insideTx).toBe(0);
        expect(captured.length).toBeGreaterThan(0);
        await vi.waitFor(() => expect(seen.every(Boolean)).toBe(true));
      } finally {
        setRealtimePublisher((envelope) => {
          captured.push(envelope);
          raw.push(JSON.stringify(envelope));
        });
        take();
      }
    });

    it("transação que falha não publica nada e não deixa dado para trás", async () => {
      const { conv } = await newConversation("oi");
      const ctx = { organizationId: A, userId: OWNER, userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "", canViewAll: true, sendingPaused: false };
      await expect(
        withOrgRealtime(db, A, async (tx) => {
          await assumeConversation(tx, ctx, conv.id);
          queueRealtime(tx, A, { type: "home.invalidate" });
          throw new Error("falha depois de gravar");
        }),
      ).rejects.toThrow("falha depois de gravar");
      expect(take()).toEqual([]);
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(row?.assigneeId).toBeNull();
    });
  });

  // ── IA ─────────────────────────────────────────────────────────────────────
  describe("IA", () => {
    it("typing do agente: true antes da resposta, false depois do commit (e a mensagem sai entre os dois)", async () => {
      const { conv } = await newConversation("Vocês fazem clareamento?");
      take();
      messaging.sent.length = 0;
      const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(report).toMatchObject({ ran: true, mode: "live" });
      // "digitando…" no WhatsApp do cliente: cada parte da resposta leva typingMs proporcional ao texto (800 ms a 6 s)
      expect(messaging.sent.length).toBeGreaterThan(0);
      for (const message of messaging.sent) {
        expect(message.typingMs).toBe(typingMsForText(message.text ?? ""));
        expect(message.typingMs).toBeGreaterThanOrEqual(800);
        expect(message.typingMs).toBeLessThanOrEqual(6000);
      }
      const events = take();
      const types = events.map((e) => `${e.event.type}${e.event.type === "typing" ? `:${e.event.active}` : ""}`);
      const on = types.indexOf("typing:true");
      const off = types.indexOf("typing:false");
      const msg = types.indexOf("conversation.message");
      expect(on).toBe(0);
      expect(msg).toBeGreaterThan(on);
      expect(off).toBe(types.length - 1);
      expect(find(events, "typing", { conversationId: conv.id, actor: "agent" })).toHaveLength(2);
      expect(find(events, "message.status", { conversationId: conv.id, status: "sent" }).length).toBeGreaterThan(0);
      expect(events.every((e) => e.organizationId === A)).toBe(true);
    });

    it("turno que não responde (prazo já reivindicado) não publica typing", async () => {
      const { conv } = await newConversation("Vocês fazem clareamento?");
      await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      take();
      const again = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(again.ran).toBe(false);
      expect(find(take(), "typing")).toHaveLength(0);
    });

    it("typing:false sai mesmo quando o modelo estoura", async () => {
      const { conv } = await newConversation("Vocês fazem clareamento?");
      take();
      const broken = { ...rt.ai, llm: { name: "quebrado", generate: async () => { throw new Error("modelo fora do ar"); } } } as typeof rt.ai;
      await runDueAiTurn(broken, rt.limiters, A, conv.id).catch(() => undefined);
      const typing = find(take(), "typing", { conversationId: conv.id });
      expect(typing.map((e) => (e.event as { active: boolean }).active)).toEqual([true, false]);
    });

    it("pedido de atendente: conversation.updated(handoff) + home.invalidate", async () => {
      const { conv } = await newConversation("Quero falar com um atendente");
      take();
      const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(report.result?.handoff).toBeTruthy();
      const events = take();
      expect(find(events, "conversation.updated", { conversationId: conv.id, reason: "handoff" }).length).toBeGreaterThan(0);
      expect(find(events, "home.invalidate")).toHaveLength(1);
    });

    it("encerramento por inatividade: um conversation.updated(resolved) por conversa e home.invalidate", async () => {
      const { conv } = await newConversation("oi");
      await withOrg(db, A, (tx) =>
        tx.update(schema.conversations).set({ lastMessageAt: new Date(Date.now() - 10 * 86_400_000), lastMessageDirection: "out" }).where(eq(schema.conversations.id, conv.id)),
      );
      take();
      await closeInactiveAiConversations(rt.ai, A);
      const events = take();
      expect(find(events, "conversation.updated", { conversationId: conv.id, reason: "resolved" })).toHaveLength(1);
      expect(find(events, "home.invalidate")).toHaveLength(1);
    });
  });

  // ── Início e Agenda ────────────────────────────────────────────────────────
  describe("Início e Agenda", () => {
    it("tarefas (Início e do cliente) e agendamentos publicam home.invalidate", async () => {
      const { conv, contact } = await newConversation("oi");

      take();
      const created = await call("owner", "POST", "/home/tasks", { title: `Tarefa sigilosa ${run}` });
      sensitive.push(`Tarefa sigilosa ${run}`);
      expect(created.status).toBe(201);
      const task = await json<{ id: string }>(created);
      expect(find(take(), "home.invalidate")).toHaveLength(1);
      expect((await call("owner", "PATCH", `/home/tasks/${task.id}`, { done: true })).status).toBe(200);
      expect(find(take(), "home.invalidate")).toHaveLength(1);
      expect((await call("other", "PATCH", `/home/tasks/${task.id}`, { done: false })).status).toBe(404);
      expect(take()).toEqual([]);

      const clientTask = await json<{ id: string }>(await call("owner", "POST", `/inbox/contacts/${contact.id}/tasks`, { title: "Ligar amanhã", dueAt: null }));
      expect(find(take(), "home.invalidate")).toHaveLength(1);
      expect((await call("owner", "PATCH", `/inbox/tasks/${clientTask.id}`, { done: true })).status).toBe(200);
      expect(find(take(), "home.invalidate")).toHaveLength(1);

      const startsAt = new Date(Date.now() + 9 * 86_400_000).toISOString().replace(/:\d{2}\.\d{3}Z$/, ":00.000Z");
      const appt = await call("owner", "POST", `/conversations/${conv.id}/appointments`, { appointmentTypeId: ids.type, startsAt, professional: "Marina Alves" });
      expect(appt.status).toBe(201);
      const appointment = await json<{ id: string }>(appt);
      expect(find(take(), "home.invalidate")).toHaveLength(1);
      expect((await call("owner", "POST", `/appointments/${appointment.id}/status`, { status: "confirmed" })).status).toBe(200);
      const events = take();
      expect(find(events, "home.invalidate")).toHaveLength(1);
      expect(events.every((e) => e.organizationId === A)).toBe(true);
    });
  });

  // ── Canais ─────────────────────────────────────────────────────────────────
  describe("Canais", () => {
    it("evento de conexão do provedor e suspensão da conta publicam channel.status com o status do canal", async () => {
      // queda de conexão
      const connectionEvent: InboundEvent = { type: "connection", status: "disconnected", at: new Date().toISOString() };
      take();
      const rec = await recordInbound(db, { organizationId: A, channelId: ids.chan, rawBody: "{}", events: [connectionEvent], parseFailed: false });
      await processInbound(db, A, channelsRt, { ids: rec.ids });
      let events = take();
      expect(find(events, "channel.status", { channelId: ids.chan, status: "disconnected" })).toHaveLength(1);
      expect(events.every((e) => e.organizationId === A)).toBe(true);

      // suspensão: desconecta os canais da empresa suspensa (só a dela)
      const chan = uuidv7();
      await insertChannel(suspendable.orgId, chan, `Susp ${run}`);
      take();
      await suspendOrganization(db, channelsRt, suspendable.orgId);
      events = take();
      expect(find(events, "channel.status", { channelId: chan, status: "disconnected" })).toHaveLength(1);
      expect(events.every((e) => e.organizationId === suspendable.orgId)).toBe(true);
    });
  });

  // ── segurança dos avisos ───────────────────────────────────────────────────
  describe("conteúdo e isolamento", () => {
    it("nenhum evento publicado neste arquivo traz texto de mensagem, nota, tarefa, nome ou telefone", () => {
      expect(raw.length).toBeGreaterThan(20);
      const joined = raw.join("\n");
      for (const secret of [...sensitive, "Cliente Sigiloso", "Marina Alves", "Rafael Costa", "Casa Alvorada", "+5567"]) {
        expect(joined.includes(secret), `vazou: ${secret}`).toBe(false);
      }
      // só chaves do contrato
      for (const line of raw) {
        const envelope = JSON.parse(line) as { event: Record<string, unknown> } & Record<string, unknown>;
        expect(Object.keys(envelope).sort()).toEqual(["at", "event", "id", "organizationId", "v"]);
        expect(Object.keys(envelope.event).every((k) => ["type", "conversationId", "direction", "reason", "messageId", "status", "channelId", "actor", "active"].includes(k))).toBe(true);
      }
    });

    it("cada empresa só vê os próprios avisos: ações na empresa A nunca saem com o id da B e vice-versa", async () => {
      take();
      await newConversation("oi", { keepEvents: true }); // empresa A
      const ownedByA = take();
      const from = phone();
      await inbound(other.orgId, ids.chanOther, from, "oi da outra");
      const ownedByB = take();
      expect(ownedByA.length).toBeGreaterThan(0);
      expect(ownedByB.length).toBeGreaterThan(0);
      expect(ownedByA.every((e) => e.organizationId === A)).toBe(true);
      expect(ownedByB.every((e) => e.organizationId === other.orgId)).toBe(true);
      const idsOfA = new Set(
        (await withOrg(db, A, (tx) => tx.select({ id: schema.conversations.id }).from(schema.conversations))).map((r) => r.id),
      );
      for (const e of ownedByB) {
        const conversationId = (e.event as { conversationId?: string }).conversationId;
        if (conversationId) expect(idsOfA.has(conversationId)).toBe(false);
      }
    });
  });
});
