import { LlmError, type GenerateRequest, type LLMProvider } from "@duckzap/ai";
import type { RealtimeEnvelope } from "@duckzap/contracts/realtime";
import { createDb, schema, withOrg } from "@duckzap/db";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../../lib/context";
import { encryptSecret } from "../../lib/crypto";
import type { InboundEvent, MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { setRealtimePublisher } from "../../lib/realtime";
import { createSecondOrg, type SecondOrg } from "../../test-support/second-org";
import { loadChannelsConfig } from "../channels/config";
import { InMemoryTokenBucket } from "../channels/rate-limit";
import { createChannelsRuntime, setChannelsRuntime } from "../channels/runtime";
import { LLM_DEFER_DELAYS_MS, runDueAiTurn } from "./ai-turn";
import { loadConversationsConfig } from "./config";
import { handleInbound } from "./inbound";
import { createConversationsRuntime } from "./runtime";

/**
 * INTEGRAÇÃO — falha passageira do provedor de IA (429/sobrecarga/timeout) não manda o cliente para a equipe.
 * Postgres real (banco descartável, nunca o `duckzap` de dev), LLM roteirizado (nunca a chave real), nenhuma espera de verdade:
 *
 *   CONVERSATIONS_INTEGRATION=1 DATABASE_URL=… DATABASE_ADMIN_URL=… npx vitest run src/modules/conversations/ai-llm-retry
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

describe.skipIf(!enabled)("IA: falha passageira do provedor adia o turno em vez de chamar a equipe (integração)", () => {
  const { db, close } = createDb(process.env.DATABASE_URL ?? "postgres://invalid/invalid", { max: 4 });
  afterAll(close);

  // ── provedor de mensagens falso e IA roteirizada ──────────────────────────
  const sentToCustomer: OutboundMessage[] = [];
  const provider: MessagingProvider = {
    kind: "evolution",
    capabilities: () => ({ buttons: false, lists: false, templates: false, media: true, reactions: false, window24h: false, presence: false }),
    connect: async () => ({ status: "connected" }),
    disconnect: async () => {},
    status: async () => "connected",
    send: async (_channel, message) => {
      sentToCustomer.push(message);
      return { ok: true, providerMessageId: `prov-${run}-${++seq}` };
    },
    verifyWebhook: async () => true,
    parseWebhook: async () => [],
  };
  setChannelsRuntime(
    createChannelsRuntime({
      config: loadChannelsConfig({ CHANNELS_SEND_BURST_QR: "100", CHANNELS_SEND_PER_SECOND_QR: "100" }),
      providers: { get: () => provider, kinds: () => ["evolution"] },
      sendLimiterFor: () => new InMemoryTokenBucket({ capacity: 1000, refillPerSecond: 1000 }),
    }),
  );

  /** "down" = 429 sempre; "auth" = chave inválida (não repetível); "up" = responde. */
  const llmState = { mode: "up" as "down" | "auth" | "up", routerAttempts: 0, smartAttempts: 0 };
  const llm: LLMProvider = {
    name: "roteirizado", // diferente de "fake": o turno não troca por o LLM de demonstração
    async generate(request: GenerateRequest) {
      const router = request.meta?.purpose === "agent_router";
      if (router) llmState.routerAttempts++;
      else llmState.smartAttempts++;
      if (llmState.mode === "down") throw new LlmError("rate_limited", "HTTP 429 RESOURCE_EXHAUSTED", true);
      if (llmState.mode === "auth") throw new LlmError("auth", "chave inválida", false);
      return {
        text: router ? JSON.stringify({ intent: "question", confidence: 0.9 }) : "Fazemos limpeza e clareamento.",
        toolCalls: [],
        stopReason: "end" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "roteirizado",
        provider: "roteirizado",
      };
    },
  };

  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const advance = (ms: number) => void (clock.t += ms);
  const queued: { conversationId: string; delayMs: number }[] = [];
  const config = loadConversationsConfig({ CONVERSATIONS_BURST_WINDOW_MS: "0", CONVERSATIONS_BURST_MAX_WAIT_MS: "0", CONVERSATIONS_SWEEP_INTERVAL_MS: "0" });
  const deps = { db, llm } as unknown as Deps;
  const makeRuntime = () => {
    const rt = createConversationsRuntime(deps, {
      config,
      now,
      scheduleAiTurn: (_org, conversationId, delayMs) => void queued.push({ conversationId, delayMs }),
      register: false,
    });
    const sleeps: number[] = [];
    rt.ai.sleep = async (ms) => void sleeps.push(ms); // nenhuma espera de verdade
    return { rt, sleeps };
  };
  let { rt, sleeps } = makeRuntime();

  let captured: RealtimeEnvelope[] = [];
  setRealtimePublisher((envelope) => void captured.push(envelope));
  afterAll(() => setRealtimePublisher(null));
  const typingFor = (conversationId: string) =>
    captured.filter((e) => e.event.type === "typing" && (e.event as { conversationId?: string }).conversationId === conversationId).map((e) => (e.event as { active: boolean }).active);

  // ── fixtures ──────────────────────────────────────────────────────────────
  let org: SecondOrg;
  let A = "";
  const ids = { chan: uuidv7(), agent: uuidv7() };

  beforeAll(async () => {
    org = await createSecondOrg("llmretry", { planSlug: "empresarial" });
    A = org.orgId;
    await withOrg(db, A, async (tx) => {
      await tx.insert(schema.channels).values({
        id: ids.chan,
        organizationId: A,
        name: `Canal ${run}`,
        type: "whatsapp_qr",
        provider: "evolution",
        status: "connected",
        address: "+556733330000",
        webhookTokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
        webhookTokenEnc: encryptSecret(A, "token"),
      });
      await tx.insert(schema.agents).values({ id: ids.agent, organizationId: A, job: "support", status: "active", currentVersion: 1 });
      await tx.update(schema.channels).set({ agentId: ids.agent }).where(eq(schema.channels.id, ids.chan));
      await tx.insert(schema.agentVersions).values({
        id: uuidv7(),
        organizationId: A,
        agentId: ids.agent,
        number: 1,
        summary: "teste",
        createdBy: org.userId,
        config: {
          name: "Agente Duck",
          profile: { description: "Atende a recepção", tone: "friendly", companySummary: "Casa Alvorada Odontologia" },
          knowledge: { productsAndServices: "Fazemos limpeza e clareamento.\nFazemos avaliação odontológica.", faq: "Atendemos de segunda a sexta.\nFicamos na Rua das Flores 100." },
          behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 5 },
          followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
          scheduling: { canBook: false, appointmentTypeIds: [] },
          advanced: { prompt: "", tools: ["search_knowledge", "request_human"] },
        },
      });
    });
  });
  afterAll(async () => {
    await org?.remove();
  });

  async function inbound(from: string, text: string) {
    const event: InboundEvent = { type: "message", externalId: `ext-${run}-${++seq}`, from, name: "Cliente Teste", kind: "text", text, at: now().toISOString() };
    await handleInbound(rt.inbound, { organizationId: A, channelId: ids.chan, event });
  }
  const convOf = async (from: string) =>
    withOrg(db, A, async (tx) => {
      const [contact] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.organizationId, A), eq(schema.contacts.phone, from)));
      const [conv] = await tx.select().from(schema.conversations).where(eq(schema.conversations.contactId, contact!.id));
      return conv!;
    });
  const messagesOf = (conversationId: string) =>
    withOrg(db, A, (tx) => tx.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId)).orderBy(schema.messages.createdAt, schema.messages.id));
  const aiEventsOf = (conversationId: string) =>
    withOrg(db, A, (tx) => tx.select().from(schema.conversationAiEvents).where(eq(schema.conversationAiEvents.conversationId, conversationId)).orderBy(schema.conversationAiEvents.createdAt));
  const agentMessages = async (conversationId: string) => (await messagesOf(conversationId)).filter((m) => m.direction === "out" && m.senderKind === "agent");

  async function newConversation(text = "Vocês fazem clareamento?") {
    const from = phone();
    await inbound(from, text);
    const conv = await convOf(from);
    return { from, conv };
  }
  function reset(mode: "down" | "auth" | "up") {
    llmState.mode = mode;
    llmState.routerAttempts = 0;
    llmState.smartAttempts = 0;
    sleeps.length = 0;
    sentToCustomer.length = 0;
    queued.length = 0;
    captured = [];
  }

  it("falha persistente: re-arma ai_due_at em 15 s / 45 s / 2 min, sem mensagem, sem handoff, estado intacto; a 4ª falha passa para a equipe", async () => {
    reset("down");
    const { conv } = await newConversation();
    const t0 = clock.t;
    expect(conv).toMatchObject({ status: "ai_active", mode: "ai" });

    const expected = [15_000, 45_000, 120_000];
    expect([...LLM_DEFER_DELAYS_MS]).toEqual(expected);
    let at = t0;
    for (const [i, delay] of expected.entries()) {
      const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
      expect(report).toMatchObject({ ran: true, reason: "llm_unavailable", mode: "live", sent: 0, retryInMs: delay });
      expect(report.result?.handoff).toBeNull();

      const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
      if (!after) throw new Error("conversa sumiu");
      expect(after.status).toBe("ai_active"); // continua com a IA
      expect(after.mode).toBe("ai");
      expect(after.waitingSince).toBeNull();
      expect(after.aiDueAt?.getTime()).toBe(at + delay);

      expect(sentToCustomer).toHaveLength(0); // NADA vai ao cliente
      expect((await agentMessages(conv.id)).length).toBe(0);
      expect((await messagesOf(conv.id)).filter((m) => m.kind === "event")).toEqual([]); // nem aviso para a equipe
      const events = await aiEventsOf(conv.id);
      expect(events.filter((e) => e.event === "llm_unavailable")).toHaveLength(i + 1);
      expect(events.some((e) => e.toState === "handoff_requested")).toBe(false);
      expect(queued.at(-1)).toEqual({ conversationId: conv.id, delayMs: delay }); // temporizador do processo (a varredura de ai_due_at cobre queda)

      // ainda não venceu: nada roda
      expect((await runDueAiTurn(rt.ai, rt.limiters, A, conv.id)).ran).toBe(false);

      advance(delay);
      at = clock.t;
      // reinício do processo entre as tentativas: o contador está no banco, não na memória
      if (i === 1) ({ rt, sleeps } = makeRuntime());
    }
    // 1 chamada + 2 novas tentativas do roteador por turno (esperas ~1,5 s e ~4 s, com jitter de ±25%)
    expect(llmState.routerAttempts).toBe(3 * 3);
    expect(llmState.smartAttempts).toBe(0);

    // 4º turno: esgotou os adiamentos → passa para a equipe, como antes (mensagem de cortesia ao cliente + aviso à equipe)
    sleeps.length = 0;
    const last = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(last.result?.handoff?.kind).toBe("llm_error");
    expect(last.reason).toBeNull();
    expect(last.retryInMs).toBeUndefined();
    expect(sleeps.length).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1125);
    expect(sleeps[0]).toBeLessThanOrEqual(1875);
    expect(sleeps[1]).toBeGreaterThanOrEqual(3000);
    expect(sleeps[1]).toBeLessThanOrEqual(5000);
    const [final] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
    expect(final).toMatchObject({ status: "handoff_requested", aiDueAt: null });
    expect(final?.waitingSince).not.toBeNull();
    expect(sentToCustomer.map((m) => m.text)).toEqual(["Vou pedir para alguém da equipe continuar esse atendimento com você."]);
    expect((await messagesOf(conv.id)).some((m) => m.kind === "event" && /chamou a equipe/.test(m.body))).toBe(true);
    const events = await aiEventsOf(conv.id);
    expect(events.filter((e) => e.event === "llm_unavailable")).toHaveLength(3);
    expect(events.some((e) => e.toState === "handoff_requested" && /IA indisponível/.test(e.reason ?? ""))).toBe(true);
  });

  it("typing do agente termina limpo (true → false) quando o turno é adiado", async () => {
    reset("down");
    const { conv } = await newConversation();
    const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(report.reason).toBe("llm_unavailable");
    expect(typingFor(conv.id)).toEqual([true, false]);
  });

  it("depois de adiar, se o provedor volta: responde UMA vez (sem duplicar) e a conversa segue o fluxo normal", async () => {
    reset("down");
    const { conv } = await newConversation();
    const first = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(first.reason).toBe("llm_unavailable");
    expect(sentToCustomer).toHaveLength(0);

    llmState.mode = "up";
    advance(15_000);
    const second = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(second).toMatchObject({ ran: true, mode: "live" });
    expect(second.sent).toBe(1);
    expect(second.result?.handoff).toBeNull();
    const out = await agentMessages(conv.id);
    expect(out).toHaveLength(1);
    expect(out[0]?.body).toBe("Fazemos limpeza e clareamento.");
    expect(out[0]?.externalId).toMatch(new RegExp(`^ai:${conv.id}:`));
    expect(sentToCustomer).toHaveLength(1);
    const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
    expect(after).toMatchObject({ status: "ai_active", aiDueAt: null }); // como em qualquer resposta da IA hoje

    // repetir o turno (varredura/temporizador atrasado) não duplica
    advance(60_000);
    expect((await runDueAiTurn(rt.ai, rt.limiters, A, conv.id)).ran).toBe(false);
    expect(await agentMessages(conv.id)).toHaveLength(1);
    expect(sentToCustomer).toHaveLength(1);
  });

  it("recuperação na tentativa de dentro do turno (429 só nas 2 primeiras): responde no mesmo turno, nada é adiado", async () => {
    reset("up");
    const { conv } = await newConversation();
    let n = 0;
    const flaky = { ...rt.ai, llm: { name: "roteirizado", generate: async (r: GenerateRequest) => { if (r.meta?.purpose === "agent_router" && n++ < 2) throw new LlmError("overloaded", "503", true); return llm.generate(r); } } } as typeof rt.ai;
    const report = await runDueAiTurn(flaky, rt.limiters, A, conv.id);
    expect(report).toMatchObject({ ran: true, sent: 1 });
    expect(report.retryInMs).toBeUndefined();
    expect(sleeps).toHaveLength(2); // duas esperas (~1,5 s e ~4 s) e a 3ª chamada funcionou
    expect((await aiEventsOf(conv.id)).filter((e) => e.event === "llm_unavailable")).toHaveLength(0);
  });

  it("erro NÃO repetível (chave inválida): passa para a equipe na hora, sem adiar", async () => {
    reset("auth");
    const { conv } = await newConversation();
    const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(report.result?.handoff?.kind).toBe("llm_error");
    expect(report.retryInMs).toBeUndefined();
    expect(llmState.routerAttempts).toBe(1);
    const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
    expect(after?.status).toBe("handoff_requested");
    expect((await aiEventsOf(conv.id)).filter((e) => e.event === "llm_unavailable")).toHaveLength(0);
  });

  it("mensagem nova do cliente durante os adiamentos recomeça a contagem (15 s de novo)", async () => {
    reset("down");
    const { from, conv } = await newConversation();
    expect((await runDueAiTurn(rt.ai, rt.limiters, A, conv.id)).retryInMs).toBe(15_000);
    advance(15_000);
    expect((await runDueAiTurn(rt.ai, rt.limiters, A, conv.id)).retryInMs).toBe(45_000);
    advance(1_000);
    await inbound(from, "Alô? Alguém aí?");
    const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(report.retryInMs).toBe(15_000);
    const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
    expect(after?.status).toBe("ai_active");
  });

  it("Copiloto: falha da sugestão não vira handoff nem adiamento e não mexe na conversa", async () => {
    reset("down");
    const { conv } = await newConversation();
    // conversa em modo Copiloto (a pessoa responde; a IA só sugere)
    await withOrg(db, A, (tx) => tx.update(schema.conversations).set({ mode: "copilot" }).where(eq(schema.conversations.id, conv.id)));
    const report = await runDueAiTurn(rt.ai, rt.limiters, A, conv.id);
    expect(report.mode).toBe("copilot");
    expect(report.retryInMs).toBeUndefined();
    expect(report.reason).not.toBe("llm_unavailable");
    expect(sentToCustomer).toHaveLength(0);
    const [after] = await withOrg(db, A, (tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id)));
    expect(after?.status).toBe("ai_active");
    expect((await aiEventsOf(conv.id)).some((e) => e.toState === "handoff_requested" || e.event === "llm_unavailable")).toBe(false);
  });
});
