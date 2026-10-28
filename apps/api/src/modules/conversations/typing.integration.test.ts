import { createFakeLlm } from "@duckzap/ai";
import type { RealtimeEnvelope } from "@duckzap/contracts/realtime";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret, generateSecret } from "../../lib/crypto";
import type { ChannelRef, MessagingProvider, OutboundPresence } from "../../lib/messaging";
import { clearPresenceHandlers } from "../../lib/presence";
import { setRealtimePublisher } from "../../lib/realtime";
import { onError } from "../../middleware/error-handler";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadChannelsConfig } from "../channels/config";
import { EVOLUTION_WEBHOOK_HEADER } from "../channels/providers/evolution";
import { sealCredentials } from "../channels/repo";
import { createChannelsRuntime, PRESENCE_LIMITS } from "../channels/runtime";
import { hashWebhookToken } from "../channels/security";
import { handleWebhook, databasePorts } from "../channels/webhook";
import { syncPresenceWebhooks } from "../channels/presence-sync";
import { loadConversationsConfig } from "./config";
import { handleInbound } from "./inbound";
import { handleContactPresence, openConversationIdForPhone } from "./presence";
import { activateConversations, createConversationsRuntime } from "./runtime";
import { ATTENDANT_TYPING_MS, conversationTypingRoutes, InMemoryTypingThrottle } from "./typing";

/**
 * INTEGRAÇÃO — "digitando…" (presença): cliente digitando (webhook → tela) e atendente digitando (tela → WhatsApp).
 * Banco descartável (NUNCA o `duckzap`):
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=… DATABASE_ADMIN_URL=… npx vitest run src/modules/conversations/typing.integration
 * Nenhuma chamada real: o provedor é um dublê que só anota o que receberia, o publicador de tempo real é falso.
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
const extId = () => `ext-typing-${run}-${++seq}`;

type PresenceCall = { ref: ChannelRef; to: string; presence: OutboundPresence; durationMs: number };

function fakeProvider() {
  const calls: PresenceCall[] = [];
  const control = { presence: true, fail: false, hasMethod: true };
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: control.presence }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async () => ({ ok: true, providerMessageId: `prov-typing-${run}` }),
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
    sendPresence: async (ref, input) => {
      calls.push({ ref, ...input });
      if (control.fail) throw new Error("Evolution fora do ar");
    },
  };
  return { provider, calls, control };
}

describe.skipIf(!enabled)("Presença / digitando… (integração)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 6 });
  afterAll(close);

  const fake = fakeProvider();
  let clock = new Date();
  const jobs: Promise<void>[] = [];
  const flush = async () => {
    await Promise.all(jobs.splice(0));
  };
  const channelsConfig = loadChannelsConfig({});
  const channelsRt = createChannelsRuntime({
    config: channelsConfig,
    providers: { get: () => fake.provider, kinds: () => ["evolution"] },
    now: () => clock,
    background: (task) => {
      jobs.push(task().catch(() => {}));
    },
    log: { warn: () => {}, error: () => {} },
  });

  // webhook de verdade: adaptador Evolution REAL (só faz parse/verificação; nenhuma chamada de rede) e limites próprios
  const webhookRt = createChannelsRuntime({
    config: channelsConfig,
    now: () => clock,
    background: (task) => {
      jobs.push(task().catch(() => {}));
    },
    log: { warn: () => {}, error: () => {} },
  });

  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const sessions: Record<string, unknown> = {};
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null } },
  } as unknown as Deps;
  const rt = createConversationsRuntime(deps, { config, now: () => new Date(), scheduleAiTurn: () => {}, register: false });

  let throttleNow = 1_000_000;
  const throttle = new InMemoryTypingThrottle({ now: () => throttleNow });
  const app = new OpenAPIHono();
  app.route("/v1", conversationTypingRoutes(deps, { channels: channelsRt, throttle }));
  app.onError(onError);
  const post = (as: string | null, id: string) => app.request(`/v1/conversations/${id}/typing`, { method: "POST", headers: as ? { "x-test-user": as } : {} });

  let captured: RealtimeEnvelope[] = [];
  setRealtimePublisher((envelope) => void captured.push(envelope));
  afterAll(() => setRealtimePublisher(null));
  const takeEvents = () => captured.splice(0);

  let main: SecondOrg;
  let other: SecondOrg;
  let suspended: SecondOrg;
  const ids = { chan: uuidv7(), chanOther: uuidv7(), chanOff: uuidv7() };
  const webhook = { token: generateSecret("dzwh_"), secret: "dzes_secret_for_typing_test", instance: `dz-typing-${run}` };

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
    main = await createSecondOrg("typ", { planSlug: "empresarial", ownerName: "Marina Alves", extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("typ-outra");
    suspended = await createSecondOrg("typ-susp", { status: "expired" });
    sessions.owner = { user: { id: main.userId, name: "Marina Alves", email: main.userEmail }, session: { id: "t1", activeOrganizationId: main.orgId } };
    sessions.agent = { user: { id: main.members.agente!.userId, name: "Rafael Costa", email: main.members.agente!.email }, session: { id: "t2", activeOrganizationId: main.orgId } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "t3", activeOrganizationId: other.orgId } };
    sessions.suspended = { user: { id: suspended.userId, name: suspended.userName, email: suspended.userEmail }, session: { id: "t4", activeOrganizationId: suspended.orgId } };
    await insertChannel(main.orgId, ids.chan, {
      webhookTokenHash: hashWebhookToken(webhook.token),
      credentialsEnc: sealCredentials(main.orgId, { instanceName: webhook.instance, webhookSecret: webhook.secret }),
    });
    await insertChannel(other.orgId, ids.chanOther, { credentialsEnc: sealCredentials(other.orgId, { instanceName: `dz-typing-other-${run}`, webhookSecret: "x" }) });
    // canal da empresa principal que NÃO é QR (sem presença)
    await insertChannel(main.orgId, ids.chanOff, { name: `Oficial ${run}`, type: "whatsapp_official", provider: "meta_cloud" });
  });
  afterAll(async () => {
    await main?.remove();
    await other?.remove();
    await suspended?.remove();
  });
  afterEach(() => {
    fake.control.presence = true;
    fake.control.fail = false;
    fake.calls.length = 0;
    clock = new Date();
    throttleNow += 60_000; // cada teste começa sem estar "recém-chamado"
    takeEvents();
  });

  async function newConversation(org: SecondOrg, channelId: string, from = phone()) {
    await handleInbound(rt.inbound, {
      organizationId: org.orgId,
      channelId,
      event: { type: "message", externalId: extId(), from, name: "Cliente", kind: "text", text: "Oi, tudo bem?", at: new Date().toISOString() },
    });
    return withOrg(db, org.orgId, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, org.orgId), eq(schema.contacts.phone, from)));
      const [conv] = await tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, contact!.id));
      return { from, conv: conv!, contact: contact! };
    });
  }
  const setConv = (org: SecondOrg, id: string, patch: Partial<typeof schema.conversations.$inferInsert>) =>
    withOrg(db, org.orgId, (tx) => tx.update(schema.conversations).set(patch).where(eq(schema.conversations.id, id)));

  // ── atendente digitando → WhatsApp do cliente ──────────────────────────────
  describe("POST /conversations/:id/typing", () => {
    it("sem sessão → 401; conta suspensa → 403 (porta da conta)", async () => {
      const { conv } = await newConversation(main, ids.chan);
      expect((await post(null, conv.id)).status).toBe(401);
      const res = await post("suspended", conv.id);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("account_suspended");
      await flush();
      expect(fake.calls).toHaveLength(0);
    });

    it("conversa de outra empresa, inexistente ou id malformado → 404, sem chamar o provedor", async () => {
      const { conv } = await newConversation(main, ids.chan);
      expect((await post("other", conv.id)).status).toBe(404);
      expect((await post("owner", uuidv7())).status).toBe(404);
      expect((await post("owner", "nao-e-guid")).status).toBe(404);
      await flush();
      expect(fake.calls).toHaveLength(0);
    });

    it("conversa que a pessoa não alcança (de outra pessoa, sem ser da fila/equipe) → 404", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      expect((await post("agent", conv.id)).status).toBe(404);
      expect((await post("owner", conv.id)).status).toBe(204);
    });

    it("conversa humana: 204 e o provedor recebe composing, ~5 s, para o telefone do contato, pelo canal da conversa", async () => {
      const { conv, from } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      const res = await post("owner", conv.id);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      await flush();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({ to: from, presence: "composing", durationMs: ATTENDANT_TYPING_MS });
      expect(fake.calls[0]!.ref.id).toBe(ids.chan);
      expect(fake.calls[0]!.ref.organizationId).toBe(main.orgId);
    });

    it("fila (handoff pedido) e copiloto também podem; resolvida não", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "handoff_requested", mode: "human" });
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(1);

      throttleNow += 10_000;
      await setConv(main, conv.id, { status: "human_active", mode: "copilot", assigneeId: main.userId });
      await post("owner", conv.id);
      await flush();
      expect(fake.calls).toHaveLength(2);

      throttleNow += 10_000;
      await setConv(main, conv.id, { status: "resolved" });
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(2);
    });

    it("enquanto a IA responde sozinha (modo IA ativo): 204 e NENHUMA chamada", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "ai_active", mode: "ai", assigneeId: null });
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(0);
    });

    it("limite: no máximo uma chamada por conversa a cada ~3,5 s; outra conversa não é afetada", async () => {
      const a = await newConversation(main, ids.chan);
      const b = await newConversation(main, ids.chan);
      for (const c of [a, b]) await setConv(main, c.conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      for (let i = 0; i < 5; i++) expect((await post("owner", a.conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(1);
      await post("owner", b.conv.id);
      await flush();
      expect(fake.calls).toHaveLength(2);
      throttleNow += 3_501;
      await post("owner", a.conv.id);
      await flush();
      expect(fake.calls).toHaveLength(3);
    });

    it("canal sem a capacidade presence (PRESENCE_ENABLED=false / outro provedor) ou não-QR: 204 sem chamar", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      fake.control.presence = false;
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(0);

      fake.control.presence = true;
      await withOrg(db, main.orgId, (tx) => tx.update(schema.conversations).set({ channelId: ids.chanOff }).where(eq(schema.conversations.id, conv.id)));
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(0);
    });

    it("canal desconectado: 204 sem chamar", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ status: "disconnected" }).where(eq(schema.channels.id, ids.chan)));
      try {
        expect((await post("owner", conv.id)).status).toBe(204);
        await flush();
        expect(fake.calls).toHaveLength(0);
      } finally {
        await withOrg(db, main.orgId, (tx) => tx.update(schema.channels).set({ status: "connected" }).where(eq(schema.channels.id, ids.chan)));
      }
    });

    it("plano com envio pausado (relógio além do vencimento): 204 sem chamar", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      clock = new Date(Date.now() + 90 * 86_400_000);
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(0);
    });

    it("falha do provedor nunca chega ao atendente: 204", async () => {
      const { conv } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId });
      fake.control.fail = true;
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(1);
    });

    it("conversa sem canal (apagado) usa o canal padrão conectado da empresa", async () => {
      const { conv, from } = await newConversation(main, ids.chan);
      await setConv(main, conv.id, { status: "human_active", mode: "human", assigneeId: main.userId, channelId: null });
      expect((await post("owner", conv.id)).status).toBe(204);
      await flush();
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.to).toBe(from);
    });
  });

  // ── cliente digitando → tela ───────────────────────────────────────────────
  describe("cliente digitando (presença recebida)", () => {
    it("openConversationIdForPhone: só a conversa aberta do contato, na empresa certa", async () => {
      const mine = await newConversation(main, ids.chan);
      const theirs = await newConversation(other, ids.chanOther, mine.from); // MESMO telefone em outra empresa
      const idMine = await withOrg(db, main.orgId, (tx) => openConversationIdForPhone(tx, main.orgId, ids.chan, mine.from));
      const idTheirs = await withOrg(db, other.orgId, (tx) => openConversationIdForPhone(tx, other.orgId, ids.chanOther, mine.from));
      expect(idMine).toBe(mine.conv.id);
      expect(idTheirs).toBe(theirs.conv.id);
      expect(idMine).not.toBe(idTheirs);
      // a empresa B não enxerga o contato da A
      const stranger = phone();
      await newConversation(main, ids.chan, stranger);
      expect(await withOrg(db, other.orgId, (tx) => openConversationIdForPhone(tx, other.orgId, ids.chanOther, stranger))).toBeNull();
      // consultar com a empresa errada nunca devolve conversa alheia, mesmo passando o id da outra
      expect(await withOrg(db, other.orgId, (tx) => openConversationIdForPhone(tx, main.orgId, ids.chan, mine.from))).toBeNull();
    });

    it("composing/recording → typing(contact, ativo); paused → inativo; só ids, só para a empresa dona", async () => {
      const { conv, from } = await newConversation(main, ids.chan);
      takeEvents();
      await handleContactPresence(db, { organizationId: main.orgId, channelId: ids.chan, from, presence: "composing" });
      await handleContactPresence(db, { organizationId: main.orgId, channelId: ids.chan, from, presence: "recording" });
      await handleContactPresence(db, { organizationId: main.orgId, channelId: ids.chan, from, presence: "paused" });
      const events = takeEvents();
      expect(events.map((e) => e.event)).toEqual([
        { type: "typing", conversationId: conv.id, actor: "contact", active: true },
        { type: "typing", conversationId: conv.id, actor: "contact", active: true },
        { type: "typing", conversationId: conv.id, actor: "contact", active: false },
      ]);
      expect(events.every((e) => e.organizationId === main.orgId)).toBe(true);
      const dump = JSON.stringify(events);
      expect(dump).not.toContain(from);
      expect(dump).not.toContain("Cliente");
    });

    it("quem não é contato, ou só tem conversa resolvida, não gera aviso; presença da empresa B nunca vai para a A", async () => {
      const { conv, from } = await newConversation(main, ids.chan);
      takeEvents();
      await handleContactPresence(db, { organizationId: main.orgId, channelId: ids.chan, from: phone(), presence: "composing" });
      await setConv(main, conv.id, { status: "resolved" });
      await handleContactPresence(db, { organizationId: main.orgId, channelId: ids.chan, from, presence: "composing" });
      // o telefone da A chegando pelo canal da B: B não tem esse contato
      await handleContactPresence(db, { organizationId: other.orgId, channelId: ids.chanOther, from, presence: "composing" });
      expect(takeEvents()).toEqual([]);
    });

    describe("pelo webhook de verdade (token → Evolution → handler registrado)", () => {
      const presenceBody = (from: string, presence = "composing") => {
        const jid = `${from.replace(/\D/g, "")}@s.whatsapp.net`;
        return JSON.stringify({ event: "presence.update", instance: webhook.instance, date_time: new Date().toISOString(), data: { id: jid, presences: { [jid]: { lastKnownPresence: presence } } } });
      };
      const hit = (body: string, secret = webhook.secret) =>
        handleWebhook(
          { ports: databasePorts(db, webhookRt), rt: webhookRt },
          new Request(`https://api.test/v1/webhooks/wa/evolution/${webhook.token}`, { method: "POST", headers: { [EVOLUTION_WEBHOOK_HEADER]: secret, "content-type": "application/json" }, body }),
          { provider: "evolution", token: webhook.token },
        );
      const inboundEventCount = () => withOrg(db, main.orgId, async (tx) => (await tx.select().from(schema.inboundEvents).where(eq(schema.inboundEvents.channelId, ids.chan))).length);

      afterAll(() => clearPresenceHandlers());

      it("200, nada em inbound_events, aviso à tela só da empresa do canal; assinatura errada = 401", async () => {
        clearPresenceHandlers();
        activateConversations(rt);
        // o handler global é registrado uma única vez por processo: garante que existe um apontando para este banco
        const { conv, from } = await newConversation(main, ids.chan);
        const otherSame = await newConversation(other, ids.chanOther, from); // mesmo telefone, outra empresa
        takeEvents();
        const before = await inboundEventCount();

        expect(await hit(presenceBody(from), "errada")).toMatchObject({ status: 401 });
        await flush();
        expect(takeEvents()).toEqual([]);

        const outcome = await hit(presenceBody(from));
        expect(outcome).toEqual({ status: 200, body: { ok: true, received: 0, duplicates: 0 } });
        await flush();
        const events = takeEvents();
        expect(events).toHaveLength(1);
        expect(events[0]!.organizationId).toBe(main.orgId);
        expect(events[0]!.event).toEqual({ type: "typing", conversationId: conv.id, actor: "contact", active: true });
        expect(events.some((e) => (e.event as { conversationId?: string }).conversationId === otherSame.conv.id)).toBe(false);
        expect(await inboundEventCount()).toBe(before);
      });

      it("rajada: o excedente é descartado e o webhook segue respondendo 200", async () => {
        const { from } = await newConversation(main, ids.chan);
        takeEvents();
        for (let i = 0; i < 40; i++) expect((await hit(presenceBody(from))).status).toBe(200);
        await flush();
        const typing = takeEvents().filter((e) => e.event.type === "typing");
        expect(typing.length).toBeGreaterThanOrEqual(1);
        expect(typing.length).toBeLessThanOrEqual(PRESENCE_LIMITS.contact.burst + 1);
      });
    });
  });

  // ── manutenção do webhook das instâncias antigas ───────────────────────────
  describe("syncPresenceWebhooks", () => {
    it("percorre só canais QR conectados (de todas as empresas, cada uma sob RLS) e conta o resultado", async () => {
      const synced: ChannelRef[] = [];
      const provider: MessagingProvider = {
        ...fake.provider,
        syncWebhook: async (ref) => {
          synced.push(ref);
          return ref.organizationId === main.orgId ? "updated" : "unchanged";
        },
      };
      const syncRt = createChannelsRuntime({
        config: loadChannelsConfig({}),
        providers: { get: () => provider, kinds: () => ["evolution"] },
        log: { warn: () => {}, error: () => {} },
      });
      const result = await syncPresenceWebhooks(db, syncRt, { pageSize: 2 }); // páginas pequenas: exercita o cursor
      const mine = synced.filter((r) => r.organizationId === main.orgId).map((r) => r.id);
      expect(mine).toContain(ids.chan);
      expect(mine).not.toContain(ids.chanOff); // API oficial não entra
      expect(synced.some((r) => r.organizationId === other.orgId && r.id === ids.chanOther)).toBe(true);
      expect(result.updated + result.unchanged + result.failed).toBe(result.channels);
      expect(result.updated).toBeGreaterThanOrEqual(1);
      expect(result.unchanged).toBeGreaterThanOrEqual(1);
    });

    it("PRESENCE_ENABLED=false ou PRESENCE_WEBHOOK_SYNC=false: não faz nada", async () => {
      let called = 0;
      const provider: MessagingProvider = { ...fake.provider, syncWebhook: async () => (called++, "updated") };
      for (const env of [{ PRESENCE_ENABLED: "false" }, { PRESENCE_WEBHOOK_SYNC: "false" }]) {
        const off = createChannelsRuntime({ config: loadChannelsConfig(env), providers: { get: () => provider, kinds: () => ["evolution"] } });
        expect(await syncPresenceWebhooks(db, off)).toEqual({ channels: 0, updated: 0, unchanged: 0, failed: 0 });
      }
      expect(called).toBe(0);
    });
  });
});
