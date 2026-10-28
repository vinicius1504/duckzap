import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import type { InboundEvent, MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { onError } from "../../middleware/error-handler";
import { loadChannelsConfig } from "../channels/config";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { createMediaRuntime, setMediaRuntime } from "../media/runtime";
import { deleteContacts } from "../contacts/service";
import { closeInactiveAiConversations, runDueAiTurn, sweepDueAiTurns } from "./ai-turn";
import { loadConversationsConfig } from "./config";
import { eraseConversationData } from "./erasure";
import { handleInbound } from "./inbound";
import { conversationsRoutes } from "./routes";
import { activateConversations, createConversationsRuntime } from "./runtime";
import { processInbound, recordInbound } from "../channels/inbound-store";
import { homeRoutes } from "../home/routes";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";

/**
 * INTEGRAÇÃO — Postgres real, papel `duckzap_app` (sem BYPASSRLS), com a migration do módulo Conversas aplicada.
 * Rode SOMENTE contra um banco descartável (nunca o `duckzap` de dev):
 *
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=<url do banco descartável, papel duckzap_app> \
 *     npx vitest run src/modules/conversations src/modules/home
 *
 * Precisa do seed de dev (org_lume = Básico VENCIDO = conta suspensa) e de `DATABASE_ADMIN_URL`: a empresa principal (plano Empresarial,
 * que tem o Copiloto), a "outra empresa" ativa e a empresa em tolerância (past_due) são criadas aqui mesmo, e removidas no fim.
 * Não mexe em `plans` nem usa a org_alvorada (compartilhada com outros arquivos que rodam em paralelo).
 * O provedor de mensagens é falso (nada sai para a rede) e o LLM é o `fake` (o fluxo usa o LLM de demonstração).
 */
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const enabled = process.env.CONVERSATIONS_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL) && Boolean(process.env.DATABASE_ADMIN_URL);

// A = empresa principal (Empresarial, criada no beforeAll); OWNER/AGENT = Marina (dona) e Rafael (atendente) dela
let A = "";
let OWNER = "";
let AGENT = "";
const LUME = "org_lume"; // Básico com assinatura vencida: conta suspensa
const run = Math.random().toString(36).slice(2, 8);
const phone = () => `+55679${randomInt(10_000_000, 99_999_999)}`;
let seq = 0;
const extId = (label = "m") => `ext-${run}-${label}-${++seq}`;

/** Próxima ocorrência de `dow` (0 = domingo) às `hour` h no fuso de São Paulo, dentro da próxima semana. */
function nextLocal(dow: number, hour: number): Date {
  const base = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    const local = new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    if (local.getDay() === dow) {
      const y = local.getFullYear();
      const m = String(local.getMonth() + 1).padStart(2, "0");
      const day = String(local.getDate()).padStart(2, "0");
      return new Date(`${y}-${m}-${day}T${String(hour).padStart(2, "0")}:00:00-03:00`);
    }
  }
  throw new Error("dia não encontrado");
}

/** Relógio que avança 1 s a cada leitura (mensagem e resposta não podem ter o mesmo instante). */
function ticking(start: Date) {
  let t = start.getTime();
  return () => new Date((t += 1000));
}

function fakeMessaging() {
  const sent: OutboundMessage[] = [];
  let n = 0;
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (_channel, message) => {
      sent.push(message);
      return { ok: true, providerMessageId: `prov-${run}-${++n}` };
    },
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
  };
  return { provider, sent };
}

describe.skipIf(!enabled)("Conversas e Início — integração (precisa da migration)", () => {
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

  const clock = { now: () => new Date() };
  const aiQueue: { org: string; conversationId: string; delayMs: number }[] = [];
  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const deps = {
    db,
    llm: createFakeLlm(),
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => sessions[headers.get("x-test-user") ?? ""] ?? null,
      },
    },
  } as unknown as Deps;
  const rt = createConversationsRuntime(deps, {
    config,
    now: () => clock.now(),
    scheduleAiTurn: (org, conversationId, delayMs) => void aiQueue.push({ org, conversationId, delayMs }),
    register: false,
  });

  const sessions: Record<string, unknown> = {
    lume: { user: { id: "usr_lume", name: "Lia Moraes", email: "contato@studiolume.com.br" }, session: { id: "s3", activeOrganizationId: LUME } },
  };
  const app = new OpenAPIHono();
  app.route(
    "/v1",
    conversationsRoutes(deps, { config, now: () => clock.now(), scheduleAiTurn: () => {}, register: false }),
  );
  app.route("/v1", homeRoutes(deps));
  app.onError(onError);

  const call = (as: string | null, method: string, path: string, body?: unknown) =>
    app.request(`/v1${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

  // ── fixtures ──────────────────────────────────────────────────────────────
  let main: SecondOrg;
  let other: SecondOrg;
  let grace: SecondOrg;
  const ids = { teamA: uuidv7(), teamB: uuidv7(), chan: uuidv7(), chanDown: uuidv7(), chanLume: uuidv7(), agent: uuidv7(), type: uuidv7(), typeStaff: uuidv7() };
  const contactIds: string[] = [];

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
    // o Copiloto é do plano Empresarial: a empresa principal destes testes é criada nele (os planos do banco não são alterados)
    main = await createSecondOrg("conversas", { planSlug: "empresarial", ownerName: "Marina Alves", extra: [{ key: "agente", role: "member", name: "Rafael Costa" }] });
    other = await createSecondOrg("conversas-outra");
    // venceu ontem: dentro da tolerância de 1 dia (past_due) a conta ainda usa tudo
    grace = await createSecondOrg("conversas-tolerancia", { daysToEnd: -1 });
    A = main.orgId;
    OWNER = main.userId;
    AGENT = main.members.agente!.userId;
    sessions.owner = { user: { id: OWNER, name: "Marina Alves", email: main.userEmail }, session: { id: "s1", activeOrganizationId: A } };
    sessions.agent = { user: { id: AGENT, name: "Rafael Costa", email: main.members.agente!.email }, session: { id: "s2", activeOrganizationId: A } };
    sessions.other = { user: { id: other.userId, name: other.userName, email: other.userEmail }, session: { id: "s4", activeOrganizationId: other.orgId } };
    sessions.grace = { user: { id: grace.userId, name: grace.userName, email: grace.userEmail }, session: { id: "s5", activeOrganizationId: grace.orgId } };
    await withOrg(db, A, async (tx) => {
      const hours = Array.from({ length: 7 }, (_, day) => ({ day, open: day >= 1 && day <= 5, start: "08:00", end: "18:00" }));
      await tx.insert(schema.teams).values([
        { id: ids.teamA, organizationId: A, name: `Recepção ${run}`, color: "blue", priority: 1, businessHours: hours },
        { id: ids.teamB, organizationId: A, name: `Vendas ${run}`, color: "green", priority: 2, businessHours: hours },
      ]);
      await tx.insert(schema.teamMembers).values({ teamId: ids.teamA, organizationId: A, memberRef: AGENT });
    });
    await insertChannel(A, ids.chan, `Recepção ${run}`, {
      teamId: ids.teamA,
      welcomeMessage: "Olá! Bem-vindo à Casa Alvorada.",
      outOfHoursMessage: "Estamos fora do horário. Retornamos no próximo dia útil.",
    });
    await insertChannel(A, ids.chanDown, `Parado ${run}`, { status: "disconnected" });
    await insertChannel(LUME, ids.chanLume, `Lume ${run}`);

    await withOrg(db, A, async (tx) => {
      await tx.insert(schema.appointmentTypes).values([
        { id: ids.type, organizationId: A, name: `Avaliação ${run}`, durationMinutes: 30 },
        { id: ids.typeStaff, organizationId: A, name: `Canal ${run}`, durationMinutes: 60, staffOnly: true },
      ]);
      await tx.insert(schema.agents).values({ id: ids.agent, organizationId: A, job: "support", status: "active", currentVersion: 1 });
      // vínculo agente↔canal: única fonte de verdade é channels.agent_id
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
            // linhas curtas (< 45 caracteres): o LLM de demonstração devolve a linha do conhecimento literalmente e o guardrail
            // de vazamento de prompt barra cópias longas do prompt
            productsAndServices: "Fazemos limpeza e clareamento.\nFazemos avaliação odontológica.",
            faq: "Atendemos de segunda a sexta.\nFicamos na Rua das Flores 100.",
          },
          behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 5 },
          followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
          scheduling: { canBook: true, appointmentTypeIds: [ids.type] },
          advanced: { prompt: "", tools: ["search_knowledge", "list_available_slots", "book_appointment", "request_human", "add_tag"] },
        },
      });
      await tx.insert(schema.copilotSettings).values({ id: uuidv7(), organizationId: A, enabled: true }).onConflictDoNothing();
    });
  });

  afterAll(async () => {
    // remover as empresas de teste leva junto (cascata) canais, equipes, agentes, contatos e conversas delas
    await main?.remove();
    await other?.remove();
    await grace?.remove();
    // a org_lume do seed é compartilhada: só sai o que este arquivo criou nela
    await withOrg(db, LUME, async (tx) => {
      const lumeContacts = (await tx.select({ id: schema.conversations.contactId }).from(schema.conversations).where(eq(schema.conversations.channelId, ids.chanLume))).map((r) => r.id);
      if (lumeContacts.length) {
        await eraseConversationData(tx, LUME, lumeContacts);
        await tx.delete(schema.contacts).where(inArray(schema.contacts.id, lumeContacts));
      }
      await tx.delete(schema.channels).where(eq(schema.channels.id, ids.chanLume));
    });
  });

  // ── helpers de cenário ────────────────────────────────────────────────────
  async function inbound(org: string, channelId: string, from: string, text: string, over: Partial<Extract<InboundEvent, { type: "message" }>> = {}) {
    const event: InboundEvent = { type: "message", externalId: extId(), from, name: "Cliente Teste", kind: "text", text, at: clock.now().toISOString(), ...over };
    await handleInbound(rt.inbound, { organizationId: org, channelId, event });
    return event as Extract<InboundEvent, { type: "message" }>;
  }

  async function conversationOf(org: string, from: string, channelId = ids.chan) {
    return withOrg(db, org, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, org), eq(schema.contacts.phone, from)));
      if (!contact) return null;
      if (!contactIds.includes(contact.id)) contactIds.push(contact.id);
      const [conv] = await tx.select().from(schema.conversations).where(and(eq(schema.conversations.contactId, contact.id), eq(schema.conversations.channelId, channelId)));
      return conv ? { conv, contact } : null;
    });
  }

  const messagesOf = (org: string, conversationId: string) =>
    withOrg(db, org, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.createdAt, schema.messages.id));

  async function newConversation(text = "Oi, tudo bem?") {
    const from = phone();
    await inbound(A, ids.chan, from, text);
    const found = await conversationOf(A, from);
    if (!found) throw new Error("conversa não criada");
    return { from, ...found };
  }

  // ── pipeline de entrada ───────────────────────────────────────────────────
  describe("mensagem recebida", () => {
    it("é idempotente: o mesmo evento do provedor nunca vira duas mensagens", async () => {
      const from = phone();
      const first = await inbound(A, ids.chan, from, "Boa tarde");
      await handleInbound(rt.inbound, { organizationId: A, channelId: ids.chan, event: first });
      await handleInbound(rt.inbound, { organizationId: A, channelId: ids.chan, event: first });
      const found = await conversationOf(A, from);
      expect(found).not.toBeNull();
      const inbound_ = (await messagesOf(A, found!.conv.id)).filter((m) => m.direction === "in");
      expect(inbound_).toHaveLength(1);
      expect(found!.conv.unreadCount).toBe(1);
    });

    it("cria contato (origem 'inbound', etapa Novos), conversa roteada para equipe e agente, e a IA fica para depois da rajada", async () => {
      const from = phone();
      aiQueue.length = 0;
      await inbound(A, ids.chan, from, "Qual o horário de atendimento?");
      const found = await conversationOf(A, from);
      expect(found!.contact.origin).toBe("inbound");
      expect(found!.conv).toMatchObject({ teamId: ids.teamA, agentId: ids.agent, mode: "ai", status: "ai_active", unreadCount: 1 });
      expect(found!.conv.aiDueAt).not.toBeNull();
      expect(aiQueue.some((q) => q.conversationId === found!.conv.id)).toBe(true);
      const stage = await withOrg(db, A, (tx) =>
        tx
          .select({ stage: schema.tags.funnelStage })
          .from(schema.contactTags)
          .innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId))
          .where(eq(schema.contactTags.contactId, found!.contact.id)),
      );
      expect(stage.map((s) => s.stage)).toEqual([1]);
    });

    it("duas mensagens simultâneas do mesmo cliente caem na MESMA conversa (índice único parcial)", async () => {
      const from = phone();
      await Promise.all([inbound(A, ids.chan, from, "oi"), inbound(A, ids.chan, from, "tem alguém aí?"), inbound(A, ids.chan, from, "olá")]);
      const found = await conversationOf(A, from);
      const all = await withOrg(db, A, (tx) => tx.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.contactId, found!.contact.id)));
      expect(all).toHaveLength(1);
      expect((await messagesOf(A, found!.conv.id)).filter((m) => m.direction === "in")).toHaveLength(3);
    });

    it("opt-out (SAIR) vem antes de tudo: bloqueia disparos, confirma uma vez e não aciona boas-vindas nem IA", async () => {
      const from = phone();
      aiQueue.length = 0;
      messaging.sent.length = 0;
      await inbound(A, ids.chan, from, "SAIR");
      const found = await conversationOf(A, from);
      const [consent] = await withOrg(db, A, (tx) => tx.select().from(schema.consents).where(eq(schema.consents.contactId, found!.contact.id)));
      expect(consent).toMatchObject({ status: "denied", method: "conversation", replyText: "SAIR" });
      expect(found!.conv.aiDueAt).toBeNull();
      expect(aiQueue.filter((q) => q.conversationId === found!.conv.id)).toHaveLength(0);
      const sentToContact = messaging.sent.filter((m) => m.to === from);
      expect(sentToContact).toHaveLength(1);
      expect(sentToContact[0]?.text).toMatch(/não vai mais receber/);
      expect(sentToContact.some((m) => /Bem-vindo/.test(m.text ?? ""))).toBe(false);
    });

    it("'quero cancelar minha consulta' NÃO é opt-out: segue o fluxo normal", async () => {
      const from = phone();
      await inbound(A, ids.chan, from, "quero cancelar minha consulta");
      const found = await conversationOf(A, from);
      const consents = await withOrg(db, A, (tx) => tx.select().from(schema.consents).where(eq(schema.consents.contactId, found!.contact.id)));
      expect(consents).toHaveLength(0);
    });

    it("resposta ao convite de consentimento: SIM concede, e a conversa não vai para a IA", async () => {
      const from = phone();
      await inbound(A, ids.chan, from, "oi"); // cria o contato
      const found = await conversationOf(A, from);
      await withOrg(db, A, (tx) =>
        tx.insert(schema.consents).values({ id: uuidv7(), organizationId: A, contactId: found!.contact.id, status: "pending", method: "invite", inviteSentAt: new Date(), inviteText: "Podemos enviar novidades?" }),
      );
      aiQueue.length = 0;
      await inbound(A, ids.chan, from, "Sim, pode");
      const [consent] = await withOrg(db, A, (tx) => tx.select().from(schema.consents).where(eq(schema.consents.contactId, found!.contact.id)));
      expect(consent).toMatchObject({ status: "granted", replyText: "Sim, pode" });
      expect(aiQueue.filter((q) => q.conversationId === found!.conv.id)).toHaveLength(0);
    });

    it("modo Somente IA (padrão): nenhuma boas-vindas nem aviso de fora do horário, mesmo com os textos preenchidos", async () => {
      messaging.sent.length = 0;
      clock.now = () => nextLocal(2, 10); // terça 10h
      const tuesday = phone();
      await inbound(A, ids.chan, tuesday, "Bom dia");
      clock.now = () => nextLocal(0, 12); // domingo 12h
      const sunday = phone();
      await inbound(A, ids.chan, sunday, "Alguém?");
      clock.now = () => new Date();
      expect(messaging.sent.filter((m) => m.to === tuesday || m.to === sunday)).toEqual([]);
      const row = await withOrg(db, A, (tx) => tx.select({ mode: schema.channels.replyMode, welcome: schema.channels.welcomeMessage }).from(schema.channels).where(eq(schema.channels.id, ids.chan)));
      expect(row[0]).toMatchObject({ mode: "ai", welcome: "Olá! Bem-vindo à Casa Alvorada." }); // textos guardados, só não são enviados
      expect((await conversationOf(A, tuesday))!.conv).toMatchObject({ mode: "ai", status: "ai_active" });
    });

    it("modo Automático: boas-vindas na conversa nova dentro do horário; aviso de fora do horário fora dele (no máximo um por 12 h)", async () => {
      const chan = uuidv7();
      await insertChannel(A, chan, `Automático ${run}`, {
        teamId: ids.teamA,
        agentId: ids.agent,
        replyMode: "auto",
        welcomeMessage: "Olá! Bem-vindo à Casa Alvorada.",
        outOfHoursMessage: "Estamos fora do horário. Retornamos no próximo dia útil.",
      });
      messaging.sent.length = 0;
      clock.now = () => nextLocal(2, 10); // terça 10h
      const tuesday = phone();
      await inbound(A, chan, tuesday, "Bom dia");
      await inbound(A, chan, tuesday, "Tem alguém?");
      expect(messaging.sent.filter((m) => m.to === tuesday).map((m) => m.text)).toEqual(["Olá! Bem-vindo à Casa Alvorada."]); // boas-vindas só uma vez

      clock.now = () => nextLocal(0, 12); // domingo 12h
      const sunday = phone();
      await inbound(A, chan, sunday, "Alguém?");
      await inbound(A, chan, sunday, "Olá?");
      const texts = messaging.sent.filter((m) => m.to === sunday).map((m) => m.text);
      expect(texts).toEqual(["Estamos fora do horário. Retornamos no próximo dia útil."]);
      clock.now = () => new Date();
    });

    it("modo Automático: conversa nova nasce em modo humano (fila) e a IA não é agendada, mesmo com agente no canal", async () => {
      const chan = uuidv7();
      await insertChannel(A, chan, `Automático sem IA ${run}`, { teamId: ids.teamA, agentId: ids.agent, replyMode: "auto" });
      aiQueue.length = 0;
      const from = phone();
      await inbound(A, chan, from, "Quero marcar uma avaliação");
      const found = await conversationOf(A, from, chan);
      expect(found!.conv).toMatchObject({ mode: "human", status: "handoff_requested", teamId: ids.teamA });
      expect(found!.conv.waitingSince).not.toBeNull();
      expect(found!.conv.aiDueAt).toBeNull();
      expect(aiQueue.filter((q) => q.conversationId === found!.conv.id)).toHaveLength(0);
    });

    it("trocar o canal para Automático não muda conversas que já existem (continuam com a IA)", async () => {
      const chan = uuidv7();
      await insertChannel(A, chan, `Troca de modo ${run}`, { teamId: ids.teamA, agentId: ids.agent });
      const from = phone();
      await inbound(A, chan, from, "Oi");
      expect((await conversationOf(A, from, chan))!.conv).toMatchObject({ mode: "ai", status: "ai_active" });
      await withOrg(db, A, (tx) => tx.update(schema.channels).set({ replyMode: "auto" }).where(eq(schema.channels.id, chan)));
      aiQueue.length = 0;
      await inbound(A, chan, from, "Ainda aí?");
      const found = await conversationOf(A, from, chan);
      expect(found!.conv).toMatchObject({ mode: "ai", status: "ai_active" });
      expect(aiQueue.some((q) => q.conversationId === found!.conv.id)).toBe(true);
    });

    it("respostas obrigatórias do sistema (opt-out) saem em todos os modos", async () => {
      for (const replyMode of ["ai", "auto"] as const) {
        const chan = uuidv7();
        await insertChannel(A, chan, `Opt-out ${replyMode} ${run}`, { teamId: ids.teamA, replyMode });
        const from = phone();
        messaging.sent.length = 0;
        await inbound(A, chan, from, "SAIR");
        const sentTo = messaging.sent.filter((m) => m.to === from);
        expect(sentTo).toHaveLength(1);
        expect(sentTo[0]?.text).toMatch(/não vai mais receber/);
      }
    });

    it("resposta '1' a um lembrete confirma o agendamento, agradece e não aciona a IA", async () => {
      const from = phone();
      await inbound(A, ids.chan, from, "oi");
      const found = await conversationOf(A, from);
      const [appt] = await withOrg(db, A, (tx) =>
        tx
          .insert(schema.appointments)
          .values({ id: uuidv7(), organizationId: A, contactId: found!.contact.id, typeId: ids.type, ownerId: OWNER, startsAt: new Date(Date.now() + 20 * 3_600_000), endsAt: new Date(Date.now() + 20 * 3_600_000 + 1_800_000), status: "pending", source: "manual" })
          .returning(),
      );
      aiQueue.length = 0;
      messaging.sent.length = 0;
      await inbound(A, ids.chan, from, "1");
      const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.id, appt!.id)));
      expect(after).toMatchObject({ status: "confirmed", confirmationReply: "1" });
      expect(aiQueue.filter((q) => q.conversationId === found!.conv.id)).toHaveLength(0);
      expect(messaging.sent.filter((m) => m.to === from).map((m) => m.text)).toEqual(["Perfeito, seu horário está confirmado. Até lá!"]);
    });

    it("quando o canal não tem agente, a conversa vai para a fila da equipe (Só humano)", async () => {
      const from = phone();
      const chan = uuidv7();
      await insertChannel(A, chan, `Sem agente ${run}`, { teamId: ids.teamB });
      await inbound(A, chan, from, "Oi");
      const found = await conversationOf(A, from, chan);
      expect(found!.conv).toMatchObject({ mode: "human", status: "handoff_requested", teamId: ids.teamB });
      expect(found!.conv.waitingSince).not.toBeNull();
      expect(found!.conv.aiDueAt).toBeNull();
    });
  });

  // ── IA ─────────────────────────────────────────────────────────────────────
  describe("IA responde (LLM fake → demonstração)", () => {
    it("responde pelo canal com externalId determinístico e não duplica se o turno repetir", async () => {
      const { from, conv } = await newConversation("Vocês fazem clareamento?");
      messaging.sent.length = 0;
      const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(report).toMatchObject({ ran: true, mode: "live" });
      expect(report.sent).toBeGreaterThan(0);
      const out = (await messagesOf(A, conv.id)).filter((m) => m.direction === "out" && m.senderKind === "agent");
      expect(out.length).toBeGreaterThan(0);
      expect(out[0]).toMatchObject({ status: "sent", senderName: "Agente Duck" });
      expect(out[0]?.externalId).toMatch(new RegExp(`^ai:${conv.id}:`));
      expect(out[0]?.body).toMatch(/clareamento/i);
      expect(messaging.sent.some((m) => m.to === from)).toBe(true);

      const again = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(again.ran).toBe(false); // prazo já reivindicado
      expect((await messagesOf(A, conv.id)).filter((m) => m.senderKind === "agent")).toHaveLength(out.length);
    });

    it("dois turnos simultâneos da mesma conversa: só um responde (lock conv:{id} + prazo reivindicado)", async () => {
      const { conv } = await newConversation("Vocês fazem clareamento?");
      const reports = await Promise.all([runDueAiTurn(rt.ai, rt.limiters, A, conv.id), runDueAiTurn(rt.ai, rt.limiters, A, conv.id)]);
      expect(reports.filter((r) => r.ran)).toHaveLength(1);
      const agentMsgs = (await messagesOf(A, conv.id)).filter((m) => m.senderKind === "agent");
      expect(new Set(agentMsgs.map((m) => m.externalId)).size).toBe(agentMsgs.length);
    });

    it("pedido de atendente vira handoff: status handoff_requested, fila da equipe, mensagem de cortesia e transições auditadas", async () => {
      const { conv } = await newConversation("Quero falar com um atendente");
      const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(report.result?.handoff?.kind).toBe("customer_request");
      const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(after).toMatchObject({ status: "handoff_requested", teamId: ids.teamA });
      expect(after?.waitingSince).not.toBeNull();
      const events = await withOrg(db, A, (tx) => tx.select().from(schema.conversationAiEvents).where(eq(schema.conversationAiEvents.conversationId, conv.id)));
      expect(events.some((e) => e.toState === "handoff_requested")).toBe(true);
      expect((await messagesOf(A, conv.id)).some((m) => m.kind === "event" && /chamou a equipe/.test(m.body))).toBe(true);
    });

    describe("Agenda é função do sistema (config.scheduling e ferramentas de agenda do agente são ignorados)", () => {
      /** Troca a config do agente de teste (versão 1) por uma derivada da atual; devolve a função que restaura. */
      async function patchAgentConfig(patch: (config: Record<string, unknown>) => Record<string, unknown>) {
        const [row] = await withOrg(db, A, (tx) => tx.select({ config: schema.agentVersions.config }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, ids.agent)));
        const original = row!.config as Record<string, unknown>;
        const set = (config: Record<string, unknown>) =>
          withOrg(db, A, (tx) => tx.update(schema.agentVersions).set({ config }).where(eq(schema.agentVersions.agentId, ids.agent)));
        await set(patch(original));
        return () => set(original);
      }
      const legacyOff = (config: Record<string, unknown>) => ({
        ...config,
        scheduling: { canBook: false, appointmentTypeIds: [] },
        advanced: { prompt: "", tools: ["search_knowledge", "request_human"] },
      });

      it("agente com canBook=false e sem ferramentas de agenda oferece horários e marca (empresa tem tipo ativo)", async () => {
        const restore = await patchAgentConfig(legacyOff);
        clock.now = ticking(nextLocal(0, 12));
        try {
          const { conv, contact, from } = await newConversation("Queria marcar uma avaliação");
          const first = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
          expect(first.result?.toolCalls.map((t) => t.tool)).toContain("list_available_slots");
          expect(first.result?.toolCalls.find((t) => t.tool === "list_available_slots")?.args.type_id).toBe(ids.type); // nunca o tipo "só a equipe"
          await withOrg(db, A, (tx) => tx.update(schema.contacts).set({ name: "Rafaela Prado" }).where(eq(schema.contacts.id, contact.id))); // marcar exige nome de verdade
          await inbound(A, ids.chan, from, "Quero marcar às 8h30");
          const second = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
          expect(second.result?.toolCalls.map((t) => t.tool)).toContain("book_appointment");
          const booked = await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, contact.id)));
          expect(booked).toHaveLength(1);
          expect(booked[0]).toMatchObject({ status: "confirmed", source: "ai_agent", typeId: ids.type });
          await withOrg(db, A, (tx) => tx.delete(schema.appointments).where(eq(schema.appointments.contactId, contact.id))); // libera o horário para o teste seguinte
        } finally {
          clock.now = () => new Date();
          await restore();
        }
      });

      it("empresa sem tipo de atendimento ativo: sem ferramentas de agenda, a IA não marca (mesmo com canBook=true no agente)", async () => {
        await withOrg(db, A, (tx) => tx.update(schema.appointmentTypes).set({ active: false }).where(eq(schema.appointmentTypes.id, ids.type)));
        clock.now = ticking(nextLocal(0, 12));
        try {
          const { conv, contact } = await newConversation("Queria marcar uma avaliação");
          const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
          const used = report.result?.toolCalls.map((t) => t.tool) ?? [];
          expect(used).not.toContain("list_available_slots");
          expect(used).not.toContain("book_appointment");
          expect(await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, contact.id)))).toHaveLength(0);
        } finally {
          clock.now = () => new Date();
          await withOrg(db, A, (tx) => tx.update(schema.appointmentTypes).set({ active: true }).where(eq(schema.appointmentTypes.id, ids.type)));
        }
      });

      it("tipos de OUTRA empresa jamais são expostos nem marcados", async () => {
        const foreign = uuidv7();
        await withOrg(db, other.orgId, (tx) => tx.insert(schema.appointmentTypes).values({ id: foreign, organizationId: other.orgId, name: `Estranho ${run}`, durationMinutes: 30 }));
        const restore = await patchAgentConfig((c) => ({ ...legacyOff(c), scheduling: { canBook: true, appointmentTypeIds: [foreign] } })); // legado apontando para tipo de fora
        clock.now = ticking(nextLocal(0, 12));
        try {
          const { conv, contact, from } = await newConversation("Queria marcar uma avaliação");
          const first = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
          const listed = first.result?.toolCalls.find((t) => t.tool === "list_available_slots");
          expect(listed?.args.type_id).toBe(ids.type);
          await inbound(A, ids.chan, from, "Quero marcar às 8h30");
          await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
          const booked = await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, contact.id)));
          expect(booked.every((b) => b.typeId === ids.type)).toBe(true);
          await withOrg(db, A, (tx) => tx.delete(schema.appointments).where(eq(schema.appointments.contactId, contact.id))); // libera o horário para o teste seguinte
          expect(await withOrg(db, other.orgId, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.typeId, foreign)))).toHaveLength(0);
        } finally {
          clock.now = () => new Date();
          await restore();
          await withOrg(db, other.orgId, (tx) => tx.delete(schema.appointmentTypes).where(eq(schema.appointmentTypes.id, foreign)));
        }
      });

      it("Copiloto usa a agenda derivada e continua sem gravar nada", async () => {
        const restore = await patchAgentConfig(legacyOff);
        clock.now = ticking(nextLocal(0, 12));
        try {
          const { conv, contact, from } = await newConversation("Queria marcar uma avaliação");
          expect((await call("owner", "POST", `/conversations/${conv.id}/mode`, { mode: "copilot" })).status).toBe(200);
          await inbound(A, ids.chan, from, "Quero marcar às 8h30");
          messaging.sent.length = 0;
          const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
          expect(report).toMatchObject({ ran: true, mode: "copilot", sent: 0 });
          expect(messaging.sent.filter((m) => m.to === from)).toHaveLength(0);
          expect(await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, contact.id)))).toHaveLength(0);
        } finally {
          clock.now = () => new Date();
          await restore();
        }
      });
    });

    it("a IA marca agendamento pendente (source ai_agent) num horário que a própria agenda ofereceu", async () => {
      clock.now = ticking(nextLocal(0, 12)); // domingo 12h: segunda 08:30 está livre e dentro do expediente
      try {
        const { conv, contact, from } = await newConversation("Queria marcar uma avaliação");
        const first = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
        expect(first.result?.toolCalls.map((t) => t.tool)).toContain("list_available_slots");
        // cadastro só com o telefone: a agenda recusa marcar e a IA pergunta o nome (nada é gravado)
        await inbound(A, ids.chan, from, "Quero marcar às 8h30");
        await withOrg(db, A, (tx) => tx.update(schema.contacts).set({ name: from }).where(eq(schema.contacts.id, contact.id))); // a mensagem preenche o nome pelo WhatsApp; aqui o cadastro volta a ter só o telefone
        const refused = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
        expect(refused.result?.toolCalls.find((t) => t.tool === "book_appointment")?.ok).toBe(false);
        expect(refused.result?.messages.join(" ")).toMatch(/nome/i);
        expect(await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, contact.id)))).toHaveLength(0);
        // com o nome salvo, marca
        await withOrg(db, A, (tx) => tx.update(schema.contacts).set({ name: "Rafaela Prado" }).where(eq(schema.contacts.id, contact.id)));
        await inbound(A, ids.chan, from, "Quero marcar às 8h30");
        const second = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
        expect(second.result?.toolCalls.map((t) => t.tool)).toContain("book_appointment");
        const booked = await withOrg(db, A, (tx) => tx.select().from(schema.appointments).where(eq(schema.appointments.contactId, contact.id)));
        expect(booked).toHaveLength(1);
        expect(booked[0]).toMatchObject({ status: "confirmed", source: "ai_agent", sourceName: "Agente Duck", typeId: ids.type });
        expect(booked[0]?.startsAt.toISOString().slice(11, 16)).toBe("11:30"); // 08:30 em São Paulo
        expect((await messagesOf(A, conv.id)).some((m) => m.kind === "event" && /marcou.*(confirmado)/.test(m.body))).toBe(true);
      } finally {
        clock.now = () => new Date();
      }
    });

    it("a IA não entrega dado de outro cliente nem age fora do escopo da conversa (ownAppointment/assertScope)", async () => {
      const a = await newConversation("oi");
      const b = await newConversation("oi");
      const [apptB] = await withOrg(db, A, (tx) =>
        tx
          .insert(schema.appointments)
          .values({ id: uuidv7(), organizationId: A, contactId: b.contact.id, typeId: ids.type, ownerId: AGENT, startsAt: new Date(Date.now() + 9 * 86_400_000), endsAt: new Date(Date.now() + 9 * 86_400_000 + 1_800_000), status: "pending", source: "manual" })
          .returning(),
      );
      const { createRealPorts } = await import("./ai-ports");
      await withOrg(db, A, async (tx) => {
        const ports = createRealPorts({
          tx,
          db,
          conv: a.conv,
          agentName: "Agente Duck",
          ctx: { organizationId: A, userId: "system", userName: "Sistema", timeZone: "America/Sao_Paulo", orgName: "x" },
          lastCustomerText: "",
          now: new Date(),
        });
        const scopeA = { organizationId: A, conversationId: a.conv.id, contactId: a.contact.id, agentId: ids.agent };
        await expect(ports.agenda.cancelAppointment(scopeA, { appointmentId: apptB!.id })).rejects.toMatchObject({ code: "not_found" });
        await expect(ports.contacts.getContact({ ...scopeA, contactId: b.contact.id })).rejects.toMatchObject({ code: "forbidden" });
        await expect(ports.conversations.requestHuman({ ...scopeA, conversationId: b.conv.id }, "x")).rejects.toMatchObject({ code: "forbidden" });
        expect(await ports.agenda.listContactAppointments(scopeA)).toEqual([]);
      });
    });

    it("sem plano ativo a IA não responde (plano expirado: nada é enviado)", async () => {
      const from = phone();
      aiQueue.length = 0;
      await inbound(LUME, ids.chanLume, from, "Olá");
      const found = await conversationOf(LUME, from, ids.chanLume);
      expect(found!.conv.aiDueAt).toBeNull();
      expect(found!.conv.mode).toBe("human");
    });
  });

  // ── despacho de Canais → handler de Conversas ─────────────────────────────
  describe("integração com Canais (lib/inbound)", () => {
    it("recordInbound + processInbound entregam mensagem e status ao handler registrado", async () => {
      activateConversations(rt);
      const channelsRt = createChannelsRuntime({
        config: channelsConfig,
        providers: { get: () => messaging.provider, kinds: () => ["evolution"] },
      });
      const from = phone();
      const msg: InboundEvent = { type: "message", externalId: extId("via-canais"), from, name: "Pelo Canais", kind: "text", text: "Olá pelo webhook", at: new Date().toISOString() };
      const recorded = await recordInbound(db, { organizationId: A, channelId: ids.chan, rawBody: "{}", events: [msg], parseFailed: false });
      expect(await processInbound(db, A, channelsRt, { ids: recorded.ids })).toEqual({ processed: 1, failed: 0 });
      const found = await conversationOf(A, from);
      expect((await messagesOf(A, found!.conv.id)).filter((m) => m.direction === "in").map((m) => m.body)).toEqual(["Olá pelo webhook"]);

      // reenvio do mesmo evento pelo provedor: a chave única do Canais barra antes de chegar aqui
      const again = await recordInbound(db, { organizationId: A, channelId: ids.chan, rawBody: "{}", events: [msg], parseFailed: false });
      expect(again.ids).toEqual([]);

      const sent = await json<{ id: string }>(await call("owner", "POST", `/conversations/${found!.conv.id}/messages`, { kind: "text", body: "Oi!", attachment: null, clientId: `c-${run}-canais` }));
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.id, sent.id)));
      const statusEvent: InboundEvent = { type: "status", externalId: row?.providerMessageId ?? "", status: "read", at: new Date().toISOString() };
      const rec2 = await recordInbound(db, { organizationId: A, channelId: ids.chan, rawBody: "{}", events: [statusEvent], parseFailed: false });
      await processInbound(db, A, channelsRt, { ids: rec2.ids });
      expect((await withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.id, sent.id))))[0]?.status).toBe("read");
    });
  });

  describe("varredura (o que um worker faria)", () => {
    it("responde conversas com prazo de IA vencido que o temporizador não cumpriu", async () => {
      const { conv } = await newConversation("Vocês fazem clareamento?");
      const swept = await sweepDueAiTurns(rt.ai, rt.limiters, A);
      expect(swept).toBeGreaterThan(0);
      const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(after?.aiDueAt).toBeNull();
      expect((await messagesOf(A, conv.id)).some((m) => m.senderKind === "agent")).toBe(true);
    });

    it("encerra por inatividade só conversa que ficou com a IA (resolvida pela IA); conversa com pessoa não", async () => {
      const ai = await newConversation("Vocês fazem clareamento?");
      await runDueAiTurn(rt.ai, rt.limiters, A, ai.conv.id);
      const human = await newConversation("oi");
      await call("owner", "POST", `/conversations/${human.conv.id}/assume`);
      const old = new Date(Date.now() - 10 * 86_400_000);
      await withOrg(db, A, (tx) => tx.update(schema.conversations).set({ lastMessageAt: old }).where(inArray(schema.conversations.id, [ai.conv.id, human.conv.id])));
      await closeInactiveAiConversations(rt.ai, A);
      const rows = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(inArray(schema.conversations.id, [ai.conv.id, human.conv.id])));
      expect(rows.find((r) => r.id === ai.conv.id)).toMatchObject({ status: "resolved", resolvedBy: "ai" });
      expect(rows.find((r) => r.id === human.conv.id)?.status).toBe("human_active");
    });
  });

  // ── Copiloto e sugestões ──────────────────────────────────────────────────
  describe("Copiloto", () => {
    it("modo Copiloto guarda a sugestão e NUNCA envia sozinho", async () => {
      const { conv, from } = await newConversation("Qual o horário de atendimento?");
      expect((await call("owner", "POST", `/conversations/${conv.id}/mode`, { mode: "copilot" })).status).toBe(200);
      await inbound(A, ids.chan, from, "Qual o horário de atendimento hoje?");
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(row?.mode).toBe("copilot");
      messaging.sent.length = 0;
      const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(report).toMatchObject({ ran: true, mode: "copilot", sent: 0 });
      expect(report.suggestionId).not.toBeNull();
      expect(messaging.sent.filter((m) => m.to === from)).toHaveLength(0);
      const suggestions = await withOrg(db, A, (tx) => tx.select().from(schema.conversationSuggestions).where(eq(schema.conversationSuggestions.conversationId, conv.id)));
      expect(suggestions[0]?.createdBy).toBeNull();
    });

    it("'sugerir resposta' gera uma sugestão e a avaliação alimenta copilot_feedback (uma vez)", async () => {
      const { conv } = await newConversation("Qual o horário de atendimento?");
      const res = await call("owner", "POST", `/conversations/${conv.id}/suggestions`);
      expect(res.status).toBe(200);
      const suggestion = await json<{ id: string; body: string }>(res);
      expect(suggestion.body.length).toBeGreaterThan(0);
      expect((await call("owner", "POST", `/inbox/suggestions/${suggestion.id}/rating`, { rating: "useful" })).status).toBe(200);
      expect((await call("owner", "POST", `/inbox/suggestions/${suggestion.id}/rating`, { rating: "useful" })).status).toBe(200);
      const feedback = await withOrg(db, A, (tx) => tx.select().from(schema.copilotFeedback).where(eq(schema.copilotFeedback.conversationId, conv.id)));
      expect(feedback).toHaveLength(1);
      expect(feedback[0]).toMatchObject({ verdict: "useful", suggestion: suggestion.body, createdBy: OWNER });
    });

    it("modo Copiloto exige o recurso no plano e o Copiloto ligado", async () => {
      const { conv } = await newConversation("oi");
      await withOrg(db, A, (tx) => tx.update(schema.copilotSettings).set({ enabled: false }).where(eq(schema.copilotSettings.organizationId, A)));
      const res = await call("owner", "POST", `/conversations/${conv.id}/mode`, { mode: "copilot" });
      expect(res.status).toBe(403);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("plan_feature");
      await withOrg(db, A, (tx) => tx.update(schema.copilotSettings).set({ enabled: true }).where(eq(schema.copilotSettings.organizationId, A)));
    });
  });

  // ── status de entrega ─────────────────────────────────────────────────────
  describe("envio e status", () => {
    it("envia pelo canal, e os eventos de status só avançam (nunca voltam)", async () => {
      const { conv } = await newConversation("oi");
      const res = await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Olá, posso ajudar?", attachment: null, clientId: `c-${run}-1` });
      expect(res.status).toBe(201);
      const sent = await json<{ id: string; status: string }>(res);
      expect(sent.status).toBe("sent");
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.id, sent.id)));
      const provider = row?.providerMessageId ?? "";
      expect(provider).toMatch(/^prov-/);
      const status = async (s: "sent" | "delivered" | "read" | "failed") =>
        handleInbound(rt.inbound, { organizationId: A, channelId: ids.chan, event: { type: "status", externalId: provider, status: s, at: new Date().toISOString() } });
      const current = async () => (await withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.id, sent.id))))[0];

      await status("delivered");
      expect((await current())?.status).toBe("delivered");
      await status("sent"); // atrasado: ignorado
      expect((await current())?.status).toBe("delivered");
      await status("read");
      expect((await current())?.status).toBe("read");
      await status("delivered");
      await status("failed");
      const after = await current();
      expect(after?.status).toBe("read");
      expect(after?.readAt).not.toBeNull();
    });

    it("o mesmo clientId não envia duas vezes (deduplicação do envio otimista)", async () => {
      const { conv } = await newConversation("oi");
      const body = { kind: "text", body: "Uma vez só", attachment: null, clientId: `c-${run}-dup` };
      const a = await json<{ id: string }>(await call("owner", "POST", `/conversations/${conv.id}/messages`, body));
      const b = await json<{ id: string }>(await call("owner", "POST", `/conversations/${conv.id}/messages`, body));
      expect(b.id).toBe(a.id);
      expect((await messagesOf(A, conv.id)).filter((m) => m.body === "Uma vez só")).toHaveLength(1);
    });

    it("assinatura: o cliente recebe o nome de quem atende (e a equipe); o sistema guarda só o que foi digitado; desligável por canal", async () => {
      const { conv, from } = await newConversation("oi");
      messaging.sent.length = 0;
      const res = await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Já te ajudo", attachment: null, clientId: `c-${run}-sign` });
      expect(res.status).toBe(201);
      const delivered = messaging.sent.filter((m) => m.to === from).map((m) => m.text);
      expect(delivered).toEqual([`*Marina (Recepção ${run}):*\nJá te ajudo`]);
      const stored = (await messagesOf(A, conv.id)).filter((m) => m.body.includes("Já te ajudo"));
      expect(stored.map((m) => m.body)).toEqual(["Já te ajudo"]); // sem assinatura no histórico

      // nota interna não vai ao cliente, então nada a assinar; canal com a assinatura desligada envia o texto puro
      await withOrg(db, A, (tx) => tx.update(schema.channels).set({ signMessages: false }).where(eq(schema.channels.id, ids.chan)));
      try {
        messaging.sent.length = 0;
        await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Sem assinatura", attachment: null, clientId: `c-${run}-nosign` });
        expect(messaging.sent.filter((m) => m.to === from).map((m) => m.text)).toEqual(["Sem assinatura"]);
      } finally {
        await withOrg(db, A, (tx) => tx.update(schema.channels).set({ signMessages: true }).where(eq(schema.channels.id, ids.chan)));
      }
    });

    it("responder uma conversa sem responsável faz a pessoa assumir", async () => {
      const { conv } = await newConversation("oi");
      await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Oi!", attachment: null, clientId: `c-${run}-assume` });
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(row).toMatchObject({ assigneeId: OWNER, status: "human_active" });
      expect(row?.firstResponseSeconds).not.toBeNull();
    });

    it("pessoa respondendo tira a IA do comando: o modo vira 'Só humano' e a IA não responde mais", async () => {
      const { conv } = await newConversation("oi");
      await withOrg(db, A, (tx) => tx.update(schema.conversations).set({ mode: "ai", status: "ai_active" }).where(eq(schema.conversations.id, conv.id)));
      await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "text", body: "Assumi", attachment: null, clientId: `c-${run}-takeover` });
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(row).toMatchObject({ mode: "human", status: "human_active", assigneeId: OWNER, aiDueAt: null });
    });

    it("nota interna não tira a IA do comando", async () => {
      const { conv } = await newConversation("oi");
      await withOrg(db, A, (tx) => tx.update(schema.conversations).set({ mode: "ai", status: "ai_active" }).where(eq(schema.conversations.id, conv.id)));
      await call("owner", "POST", `/conversations/${conv.id}/messages`, { kind: "note", body: "só para a equipe", attachment: null, clientId: `c-${run}-note-only` });
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      expect(row).toMatchObject({ mode: "ai", status: "ai_active" });
    });

    it("canal desconectado: a mensagem fica 'failed' com a dica de reconectar; depois de reconectar, o reenvio funciona", async () => {
      const from = phone();
      await inbound(A, ids.chanDown, from, "oi"); // evento ainda entra
      const found = await conversationOf(A, from, ids.chanDown);
      const res = await call("owner", "POST", `/conversations/${found!.conv.id}/messages`, { kind: "text", body: "Resposta", attachment: null, clientId: `c-${run}-down` });
      expect(res.status).toBe(201);
      const failed = await json<{ id: string; status: string; failureReason: string; reconnect?: boolean }>(res);
      expect(failed).toMatchObject({ status: "failed", reconnect: true });
      expect(failed.failureReason).toMatch(/Reconecte em Canais/);

      const still = await call("owner", "POST", `/conversations/${found!.conv.id}/messages/${failed.id}/resend`);
      expect(still.status).toBe(409);
      expect((await json<{ error: { code: string } }>(still)).error.code).toBe("channel_down");

      await withOrg(db, A, (tx) => tx.update(schema.channels).set({ status: "connected" }).where(eq(schema.channels.id, ids.chanDown)));
      const ok = await call("owner", "POST", `/conversations/${found!.conv.id}/messages/${failed.id}/resend`);
      expect(ok.status).toBe(200);
      expect((await json<{ status: string }>(ok)).status).toBe("sent");
      const again = await call("owner", "POST", `/conversations/${found!.conv.id}/messages/${failed.id}/resend`);
      expect((await json<{ error: { code: string } }>(again)).error.code).toBe("not_failed");
      await withOrg(db, A, (tx) => tx.update(schema.channels).set({ status: "disconnected" }).where(eq(schema.channels.id, ids.chanDown)));
    });

    it("anexo sem armazenamento de mídia configurado é recusado com motivo claro (503), sem criar mensagem", async () => {
      setMediaRuntime(createMediaRuntime({ storage: null })); // hermético: ignora MEDIA_STORAGE_* do .env de quem roda
      const { conv } = await newConversation("oi");
      const res = await call("owner", "POST", `/conversations/${conv.id}/messages`, {
        kind: "image",
        body: "",
        attachment: { fileName: "foto.png", mimeType: "image/png", sizeBytes: 100, durationSeconds: null, url: null, mediaId: uuidv7() },
        clientId: `c-${run}-img`,
      });
      expect(res.status).toBe(503);
      const err = await json<{ error: { code: string; message: string } }>(res);
      expect(err.error.code).toBe("media_unavailable");
      expect(err.error.message).toMatch(/armazenamento de mídia não foi configurado/);
      expect((await messagesOf(A, conv.id)).filter((m) => m.direction === "out")).toHaveLength(0);
    });

    it("conta suspensa (plano expirado): bloqueio TOTAL no servidor (403 account_suspended), inclusive leitura e nota interna", async () => {
      const from = phone();
      await inbound(LUME, ids.chanLume, from, "Olá"); // o evento do cliente ainda entra (fica gravado)
      const found = await conversationOf(LUME, from, ids.chanLume);
      for (const [method, path, body] of [
        ["GET", `/conversations/${found!.conv.id}`],
        ["GET", "/conversations?tab=all"],
        ["POST", `/conversations/${found!.conv.id}/messages`, { kind: "text", body: "oi", attachment: null, clientId: "x1" }],
        ["POST", `/conversations/${found!.conv.id}/messages`, { kind: "note", body: "ligar amanhã", attachment: null, clientId: "x2" }],
        ["POST", `/conversations/${found!.conv.id}/messages/${uuidv7()}/resend`],
        ["GET", "/home/overview"],
      ] as [string, string, unknown?][]) {
        const res = await call("lume", method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await json<{ error: { code: string } }>(res)).error.code, `${method} ${path}`).toBe("account_suspended");
      }
      expect((await messagesOf(LUME, found!.conv.id)).filter((m) => m.direction === "out")).toHaveLength(0); // nada saiu
    });

    it("dentro da tolerância de 1 dia (past_due) a conta ainda usa tudo, inclusive enviar", async () => {
      const chan = uuidv7();
      await insertChannel(grace.orgId, chan, `Tolerância ${run}`);
      const from = phone();
      await inbound(grace.orgId, chan, from, "Olá");
      const found = await conversationOf(grace.orgId, from, chan);
      expect((await call("grace", "GET", `/conversations/${found!.conv.id}`)).status).toBe(200);
      const sent = await call("grace", "POST", `/conversations/${found!.conv.id}/messages`, { kind: "text", body: "oi", attachment: null, clientId: `g-${run}` });
      expect(sent.status).toBe(201);
      expect((await json<{ status: string }>(sent)).status).toBe("sent");
    });
  });

  // ── visibilidade e autorização ────────────────────────────────────────────
  describe("quem vê o quê", () => {
    it("sem view_all: não lê conversa de outra pessoa (404), não a vê na lista; a fila é só da equipe dele (ou sem equipe)", async () => {
      const { conv: mine } = await newConversation("oi"); // canal da equipe A, sem responsável → equipe do Rafael
      const { conv: others } = await newConversation("oi");
      await call("owner", "POST", `/conversations/${others.id}/assume`); // Marina assume: sai do alcance do Rafael
      // canal SEM agente: a conversa nasce em "Aguardando" (fila) da equipe do canal, ou de ninguém se o canal não tem equipe
      const queueOf = async (label: string, over: Partial<typeof schema.channels.$inferInsert>) => {
        const from = phone();
        const chan = uuidv7();
        await insertChannel(A, chan, `Fila ${label} ${run}-${seq}`, over);
        await inbound(A, chan, from, "oi");
        const f = await conversationOf(A, from, chan);
        return f!.conv;
      };
      const queued = await queueOf("equipe B", { teamId: ids.teamB }); // fila de OUTRA equipe
      const queuedOwnTeam = await queueOf("equipe A", { teamId: ids.teamA }); // fila da equipe dele
      const queuedNoTeam = await queueOf("sem equipe", {}); // fila sem equipe: de todos

      expect((await call("agent", "GET", `/conversations/${mine.id}`)).status).toBe(200); // da equipe dele
      expect((await call("agent", "GET", `/conversations/${others.id}`)).status).toBe(404); // de outra pessoa
      expect((await call("agent", "GET", `/conversations/${queued.id}`)).status).toBe(404); // fila de outra equipe
      expect((await call("agent", "GET", `/conversations/${queuedOwnTeam.id}`)).status).toBe(200);
      expect((await call("agent", "GET", `/conversations/${queuedNoTeam.id}`)).status).toBe(200);
      expect((await call("owner", "GET", `/conversations/${others.id}`)).status).toBe(200);
      expect((await call("owner", "GET", `/conversations/${queued.id}`)).status).toBe(200); // quem vê tudo vê a fila de qualquer equipe

      const listAgent = await json<{ items: { id: string }[]; counts: Record<string, number> }>(await call("agent", "GET", "/conversations?tab=mine"));
      // Minhas é só o que foi atribuído a ele; a conversa da equipe que a IA atende fica na aba IA, a fila em Aguardando
      expect(listAgent.items.map((i) => i.id)).not.toContain(mine.id);
      expect(listAgent.items.map((i) => i.id)).not.toContain(others.id);
      expect(listAgent.items.map((i) => i.id)).not.toContain(queuedOwnTeam.id);
      const aiTab = await json<{ items: { id: string }[] }>(await call("agent", "GET", "/conversations?tab=ai"));
      expect(aiTab.items.map((i) => i.id)).toContain(mine.id);
      expect(aiTab.items.map((i) => i.id)).not.toContain(others.id); // assumida por outra pessoa: sai do alcance dele
      expect(aiTab.items.map((i) => i.id)).not.toContain(queuedOwnTeam.id); // fila de pessoa não é "IA atendendo"
      const ownerAi = await json<{ items: { id: string }[] }>(await call("owner", "GET", "/conversations?tab=ai"));
      expect(ownerAi.items.map((i) => i.id)).toContain(mine.id);
      const waiting = await json<{ items: { id: string }[] }>(await call("agent", "GET", "/conversations?tab=waiting"));
      const waitingIds = waiting.items.map((i) => i.id);
      expect(waitingIds).toEqual(expect.arrayContaining([queuedOwnTeam.id, queuedNoTeam.id]));
      expect(waitingIds).not.toContain(queued.id);
      const ownerWaiting = await json<{ items: { id: string }[] }>(await call("owner", "GET", "/conversations?tab=waiting"));
      expect(ownerWaiting.items.map((i) => i.id)).toContain(queued.id);
      const all = await json<{ items: unknown[]; counts: Record<string, number> }>(await call("agent", "GET", "/conversations?tab=all"));
      expect(all.items).toEqual([]);
      expect(all.counts.all).toBe(0);

      const ownerAll = await json<{ items: { id: string }[] }>(await call("owner", "GET", "/conversations?tab=all"));
      expect(ownerAll.items.map((i) => i.id)).toEqual(expect.arrayContaining([mine.id, others.id]));
      // mutação em conversa fora do alcance = 404, não 403
      expect((await call("agent", "POST", `/conversations/${others.id}/assume`)).status).toBe(404);
      expect((await call("agent", "POST", `/conversations/${others.id}/messages`, { kind: "text", body: "oi", attachment: null, clientId: "z" })).status).toBe(404);
      expect((await call("agent", "GET", `/inbox/access/conversation/${others.id}`)).status).toBe(404);
      expect((await call("agent", "GET", `/inbox/access/conversation/${mine.id}`)).status).toBe(200);
    });

    it("outra empresa: 404 em tudo (leitura e escrita), mesmo com o id certo", async () => {
      const { conv, contact } = await newConversation("oi");
      for (const [method, path, body] of [
        ["GET", `/conversations/${conv.id}`],
        ["POST", `/conversations/${conv.id}/assume`],
        ["POST", `/conversations/${conv.id}/resolve`],
        ["POST", `/conversations/${conv.id}/read`],
        ["POST", `/conversations/${conv.id}/messages`, { kind: "note", body: "x", attachment: null, clientId: "c" }],
        ["POST", `/conversations/${conv.id}/suggestions`],
        ["POST", `/inbox/contacts/${contact.id}/tags`, { tagIds: [] }],
        ["PATCH", `/inbox/contacts/${contact.id}/notes`, { notes: "vazou?" }],
      ] as [string, string, unknown?][]) {
        const res = await call("other", method, path, body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      const listOther = await json<{ items: { id: string }[] }>(await call("other", "GET", "/conversations?tab=all"));
      expect(listOther.items.map((i) => i.id)).not.toContain(conv.id);
    });

    it("permissões da matriz: sem sessão 401; atendente sem settings.manage 403", async () => {
      expect((await call(null, "GET", "/conversations")).status).toBe(401);
      expect((await call("agent", "POST", "/quick-replies", { shortcut: "x", title: "x", body: "x" })).status).toBe(403);
      expect((await call("owner", "POST", "/quick-replies", { shortcut: `atalho-${run}`, title: "Teste", body: "Corpo" })).status).toBe(201);
    });

    it("filtros: canal, equipe, prioridade e busca (nome, telefone e texto de mensagem) respeitam a visibilidade", async () => {
      const { conv, from } = await newConversation("palavra-rara-" + run);
      const byText = await json<{ items: { id: string }[] }>(await call("owner", "GET", `/conversations?tab=all&search=${encodeURIComponent("palavra-rara-" + run)}`));
      expect(byText.items.map((i) => i.id)).toEqual([conv.id]);
      const byPhone = await json<{ items: { id: string }[] }>(await call("owner", "GET", `/conversations?tab=all&search=${encodeURIComponent(from.slice(-8))}`));
      expect(byPhone.items.map((i) => i.id)).toContain(conv.id);
      const wildcard = await json<{ items: unknown[] }>(await call("owner", "GET", "/conversations?tab=all&search=%25"));
      expect(wildcard.items.length).toBeLessThan(5); // "%" é literal, não curinga
      const byChannel = await json<{ items: { id: string }[] }>(await call("owner", "GET", `/conversations?tab=all&channelId=${ids.chanDown}`));
      expect(byChannel.items.map((i) => i.id)).not.toContain(conv.id);
      const badId = await json<{ items: unknown[] }>(await call("owner", "GET", "/conversations?tab=all&channelId=nao-e-uuid"));
      expect(badId.items).toEqual([]);
    });
  });

  // ── ações ──────────────────────────────────────────────────────────────────
  describe("ações sobre a conversa", () => {
    it("assumir, transferir (pessoa e equipe + nota), modo, resolver, reabrir e eventos na linha do tempo", async () => {
      const { conv } = await newConversation("oi");
      expect((await call("owner", "POST", `/conversations/${conv.id}/assume`)).status).toBe(200);
      let detail = await json<{ conversation: { status: string; assigneeId: string; mode: string }; messages: { kind: string; body: string }[] }>(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation).toMatchObject({ status: "human_active", assigneeId: OWNER, mode: "copilot" }); // Copiloto ligado no banco de teste
      expect(detail.messages.some((m) => m.kind === "event" && /Marina Alves assumiu/.test(m.body))).toBe(true);

      expect((await call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "member", memberId: AGENT }, note: "Cliente quer orçamento" })).status).toBe(200);
      detail = await json(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation).toMatchObject({ status: "human_active", assigneeId: AGENT });
      expect(detail.messages.some((m) => m.kind === "note" && m.body === "Cliente quer orçamento")).toBe(true);

      expect((await call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "team", teamId: ids.teamB }, note: null })).status).toBe(200);
      detail = await json(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation).toMatchObject({ status: "handoff_requested", assigneeId: null });
      // fila da equipe B: o atendente (só da equipe A) deixa de ver; transferida para a equipe A, ele passa a ver em Aguardando
      expect((await call("agent", "GET", `/conversations/${conv.id}`)).status).toBe(404);
      expect((await call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "team", teamId: ids.teamA }, note: null })).status).toBe(200);
      expect((await call("agent", "GET", `/conversations/${conv.id}`)).status).toBe(200);
      const queueNow = await json<{ items: { id: string }[] }>(await call("agent", "GET", "/conversations?tab=waiting"));
      expect(queueNow.items.map((i) => i.id)).toContain(conv.id);
      expect((await call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "team", teamId: ids.teamB }, note: null })).status).toBe(200);

      const bad =await call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "member", memberId: "usr_lume" }, note: null });
      expect(bad.status).toBe(422); // pessoa de outra empresa não é destino válido
      expect((await call("owner", "POST", `/conversations/${conv.id}/transfer`, { target: { kind: "team", teamId: uuidv7() }, note: null })).status).toBe(422);

      expect((await call("owner", "POST", `/conversations/${conv.id}/mode`, { mode: "human" })).status).toBe(200);
      expect((await call("owner", "POST", `/conversations/${conv.id}/resolve`)).status).toBe(200);
      detail = await json(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation.status).toBe("resolved");
      expect((await call("owner", "POST", `/conversations/${conv.id}/assume`)).status).toBe(409);
      expect((await call("owner", "POST", `/conversations/${conv.id}/reopen`)).status).toBe(200);
      detail = await json(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation.status).toBe("human_active");
    });

    it("cliente volta a escrever numa conversa resolvida: reabre (dentro da janela) em vez de abrir outra", async () => {
      const { conv, from } = await newConversation("oi");
      await call("owner", "POST", `/conversations/${conv.id}/resolve`);
      await inbound(A, ids.chan, from, "mais uma dúvida");
      const all = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, conv.contactId)));
      expect(all).toHaveLength(1);
      expect(all[0]?.status).not.toBe("resolved");
      expect((await messagesOf(A, conv.id)).some((m) => /reaberta/.test(m.body))).toBe(true);
    });

    it("etapa do funil (uma só), etiquetas (sem etapas) e nota do painel aparecem no detalhe e na ficha de Clientes", async () => {
      const { conv, contact } = await newConversation("oi");
      const lookups = await json<{ tags: { id: string; name: string; funnelStage: number | null }[] }>(await call("owner", "GET", "/inbox/lookups"));
      const stage3 = lookups.tags.find((t) => t.funnelStage === 3);
      const plain = await withOrg(db, A, async (tx) => {
        const [t] = await tx.insert(schema.tags).values({ id: uuidv7(), organizationId: A, name: `Etiqueta ${run}`, color: "ink", position: 50 }).returning();
        return t!;
      });
      expect((await call("owner", "POST", `/conversations/${conv.id}/stage`, { stageId: stage3!.id })).status).toBe(200);
      expect((await call("owner", "POST", `/conversations/${conv.id}/stage`, { stageId: plain.id })).status).toBe(422); // etiqueta comum não é etapa
      expect((await call("owner", "POST", `/inbox/contacts/${contact.id}/tags`, { tagIds: [plain.id] })).status).toBe(200);
      expect((await call("owner", "POST", `/inbox/contacts/${contact.id}/tags`, { tagIds: [stage3!.id] })).status).toBe(422); // etapa não entra como etiqueta
      expect((await call("owner", "PATCH", `/inbox/contacts/${contact.id}/notes`, { notes: "Prefere manhã" })).status).toBe(200);
      const detail = await json<{ conversation: { stageId: string; tagIds: string[] }; contact: { notes: string } }>(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation).toMatchObject({ stageId: stage3!.id, tagIds: [plain.id] });
      expect(detail.contact.notes).toBe("Prefere manhã");
      const stages = await withOrg(db, A, (tx) =>
        tx.select({ stage: schema.tags.funnelStage }).from(schema.contactTags).innerJoin(schema.tags, eq(schema.tags.id, schema.contactTags.tagId)).where(and(eq(schema.contactTags.contactId, contact.id), sql`${schema.tags.funnelStage} is not null`)),
      );
      expect(stages).toEqual([{ stage: 3 }]);
      const notes = await withOrg(db, A, (tx) => tx.select().from(schema.contactNotes).where(eq(schema.contactNotes.contactId, contact.id)));
      expect(notes).toHaveLength(1); // a nota do painel é uma nota da ficha
      await call("owner", "PATCH", `/inbox/contacts/${contact.id}/notes`, { notes: "" });
      expect(await withOrg(db, A, (tx) => tx.select().from(schema.contactNotes).where(eq(schema.contactNotes.contactId, contact.id)))).toHaveLength(0);
    });

    it("follow-up: agenda, pausa, cancela; passado é recusado", async () => {
      const { conv } = await newConversation("oi");
      const future = new Date(Date.now() + 3_600_000).toISOString();
      expect((await call("owner", "PATCH", `/conversations/${conv.id}/follow-up`, { paused: true })).status).toBe(409); // sem follow-up
      expect((await call("owner", "POST", `/conversations/${conv.id}/follow-up`, { scheduledAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(422);
      expect((await call("owner", "POST", `/conversations/${conv.id}/follow-up`, { scheduledAt: future })).status).toBe(200);
      expect((await call("owner", "PATCH", `/conversations/${conv.id}/follow-up`, { paused: true })).status).toBe(200);
      let detail = await json<{ conversation: { followUp: { paused: boolean } | null } }>(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation.followUp?.paused).toBe(true);
      expect((await call("owner", "DELETE", `/conversations/${conv.id}/follow-up`)).status).toBe(200);
      detail = await json(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.conversation.followUp).toBeNull();
    });

    it("agendar pelo painel usa a Agenda: cria pendente, recusa conflito do mesmo profissional e aparece no cliente", async () => {
      const { conv } = await newConversation("oi");
      const startsAt = new Date(Date.now() + 5 * 86_400_000).toISOString().replace(/:\d{2}\.\d{3}Z$/, ":00.000Z");
      const body = { appointmentTypeId: ids.type, startsAt, professional: "Marina Alves" };
      const created = await call("owner", "POST", `/conversations/${conv.id}/appointments`, body);
      expect(created.status).toBe(201);
      expect(await json(created)).toMatchObject({ status: "pending", professional: "Marina Alves", typeName: `Avaliação ${run}` });
      const clash = await call("owner", "POST", `/conversations/${conv.id}/appointments`, body);
      expect(clash.status).toBe(409);
      expect((await json<{ error: { code: string } }>(clash)).error.code).toBe("conflict");
      expect((await call("owner", "POST", `/conversations/${conv.id}/appointments`, { ...body, professional: "Ninguém" })).status).toBe(422);
      expect((await call("owner", "POST", `/conversations/${conv.id}/appointments`, { ...body, appointmentTypeId: uuidv7() })).status).toBe(422);
      const detail = await json<{ contact: { appointments: { typeName: string }[] } }>(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.contact.appointments).toHaveLength(1);
    });

    it("tarefas do cliente: criar e concluir, só para quem alcança o cliente", async () => {
      const { conv, contact } = await newConversation("oi");
      await call("owner", "POST", `/conversations/${conv.id}/assume`); // fora do alcance do Rafael
      const created = await call("owner", "POST", `/inbox/contacts/${contact.id}/tasks`, { title: "Ligar amanhã", dueAt: null });
      expect(created.status).toBe(201);
      const task = await json<{ id: string }>(created);
      expect((await call("agent", "PATCH", `/inbox/tasks/${task.id}`, { done: true })).status).toBe(404);
      expect((await call("agent", "GET", `/inbox/access/task/${task.id}`)).status).toBe(404);
      expect((await call("owner", "PATCH", `/inbox/tasks/${task.id}`, { done: true })).status).toBe(200);
      const detail = await json<{ contact: { tasks: { done: boolean }[] } }>(await call("owner", "GET", `/conversations/${conv.id}`));
      expect(detail.contact.tasks[0]?.done).toBe(true);
    });
  });

  // ── LGPD ────────────────────────────────────────────────────────────────────
  describe("exclusão do titular (LGPD)", () => {
    it("apagar o contato leva conversas, mensagens, sugestões, auditoria e feedback junto", async () => {
      const { conv, contact } = await newConversation("Qual o horário de atendimento?");
      await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      const s = await json<{ id: string }>(await call("owner", "POST", `/conversations/${conv.id}/suggestions`));
      await call("owner", "POST", `/inbox/suggestions/${s.id}/rating`, { rating: "bad" });
      await withOrg(db, A, async (tx) => {
        await eraseConversationData(tx, A, [contact.id]);
        await deleteContacts(tx, { organizationId: A, userId: OWNER, userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "x" }, [contact.id]);
      });
      await withOrg(db, A, async (tx) => {
        expect(await tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id))).toHaveLength(0);
        expect(await tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conv.id))).toHaveLength(0);
        expect(await tx.select().from(schema.conversationSuggestions).where(eq(schema.conversationSuggestions.conversationId, conv.id))).toHaveLength(0);
        expect(await tx.select().from(schema.copilotFeedback).where(eq(schema.copilotFeedback.conversationId, conv.id))).toHaveLength(0);
        expect(await tx.select().from(schema.conversationAiEvents).where(eq(schema.conversationAiEvents.conversationId, conv.id))).toHaveLength(0);
      });
    });
  });

  // ── Início ─────────────────────────────────────────────────────────────────
  describe("Início", () => {
    it("números reais: fila, abertas, novas hoje, conversas por dia, funil somando 100% e canal caído", async () => {
      await newConversation("oi");
      const res = await call("owner", "GET", "/home/overview?period=30d");
      expect(res.status).toBe(200);
      const home = await json<{
        attention: { kind: string; title: string }[];
        kpis: { openConversations: number; newToday: number; resolvedByAiPercent: number };
        conversationsPerDay: { date: string; count: number }[];
        funnel: { stage: string; percent: number }[];
        weeklyConversion: unknown[];
        conversationsByAgent: unknown[];
      }>(res);
      expect(home.kpis.openConversations).toBeGreaterThan(0);
      expect(home.kpis.newToday).toBeGreaterThan(0);
      expect(home.conversationsPerDay).toHaveLength(7);
      expect(home.conversationsPerDay.reduce((n, d) => n + d.count, 0)).toBeGreaterThan(0);
      expect(home.funnel.map((f) => f.stage)).toHaveLength(4);
      expect(home.funnel.reduce((n, f) => n + f.percent, 0)).toBe(100);
      expect(home.weeklyConversion).toHaveLength(4);
      expect(home.attention.some((a) => a.kind === "channel_down")).toBe(true);
      expect(home.conversationsByAgent.length).toBeGreaterThan(0);
    });

    it("atendente (sem home.view_team_metrics) não recebe o ranking por atendente; vê só o que alcança", async () => {
      const ownerHome = await json<{ kpis: { openConversations: number } }>(await call("owner", "GET", "/home/overview?period=today"));
      const agentHome = await json<{ conversationsByAgent: unknown[]; kpis: { openConversations: number } }>(await call("agent", "GET", "/home/overview?period=today"));
      expect(agentHome.conversationsByAgent).toEqual([]);
      expect(agentHome.kpis.openConversations).toBeLessThanOrEqual(ownerHome.kpis.openConversations);
    });

    it("tarefas: criar, concluir e rótulos; uma pessoa não mexe na tarefa de outra", async () => {
      const created = await call("owner", "POST", "/home/tasks", { title: `Tarefa ${run}` });
      expect(created.status).toBe(201);
      const task = await json<{ id: string; dueLabel: string; assignee: string; priority: string; done: boolean }>(created);
      expect(task).toMatchObject({ dueLabel: "Sem prazo", assignee: "Você", priority: "medium", done: false });
      expect((await call("agent", "PATCH", `/home/tasks/${task.id}`, { done: true })).status).toBe(404); // da Marina; o Rafael não vê as métricas da equipe
      expect((await call("other", "PATCH", `/home/tasks/${task.id}`, { done: true })).status).toBe(404);
      expect((await call("owner", "PATCH", `/home/tasks/${task.id}`, { done: true })).status).toBe(200);
      const home = await json<{ tasks: { id: string; done: boolean; dueLabel: string }[] }>(await call("owner", "GET", "/home/overview"));
      expect(home.tasks.find((t) => t.id === task.id)).toMatchObject({ done: true, dueLabel: "Concluída hoje" });
      expect((await call("owner", "POST", "/home/tasks", { title: "  " })).status).toBe(422);
      const agentHome = await json<{ tasks: { id: string }[] }>(await call("agent", "GET", "/home/overview"));
      expect(agentHome.tasks.some((t) => t.id === task.id)).toBe(false);
    });
  });

  it("lookups do inbox trazem canais, equipes, pessoas, agentes, etiquetas, respostas rápidas e tipos ativos", async () => {
    const res = await call("owner", "GET", "/inbox/lookups");
    expect(res.status).toBe(200);
    const l = await json<{
      channels: { id: string; kind: string; status: string }[];
      teams: { id: string }[];
      members: { id: string; teamIds: string[] }[];
      agents: { id: string; name: string }[];
      tags: { funnelStage: number | null }[];
      quickReplies: unknown[];
      appointmentTypes: { id: string }[];
      professionals: string[];
    }>(res);
    expect(l.channels.find((c) => c.id === ids.chan)).toMatchObject({ kind: "whatsapp_qr", status: "connected" });
    expect(l.channels.find((c) => c.id === ids.chanDown)?.status).toBe("disconnected");
    expect(l.channels.some((c) => c.id === ids.chanLume)).toBe(false); // outra empresa
    expect(l.members.find((m) => m.id === AGENT)?.teamIds).toContain(ids.teamA);
    expect(l.agents.find((a) => a.id === ids.agent)?.name).toBe("Agente Duck");
    expect(l.tags.filter((t) => t.funnelStage !== null)).toHaveLength(4);
    expect(l.quickReplies.length).toBeGreaterThan(0);
    expect(l.appointmentTypes.some((t) => t.id === ids.type)).toBe(true);
    expect(l.professionals).toContain("Marina Alves");
    expect(l.professionals).not.toContain("Lia Moraes");
  });
});
