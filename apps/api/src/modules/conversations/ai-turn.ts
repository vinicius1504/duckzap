import {
  bookableTypeIds,
  createDemoLlm,
  effectiveCatalogConfig,
  effectiveSchedulingConfig,
  LlmError,
  createConversationRateLimiter,
  runAgentTurn,
  SKIP_LLM_UNAVAILABLE,
  tokenBudget,
  type AgentRuntimeConfig,
  type ChatMessage,
  type LLMProvider,
  type TurnResult,
  type UsageEvent,
} from "@duckzap/ai";
import type { ReplySuggestion, SuggestionRating } from "@duckzap/contracts/conversations";
import { schema, withOrg, type Database, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import { resolvePlan, tokenLimitValue } from "../../lib/plan";
import { typingMsForText } from "../../lib/presence";
import { publishRealtime, queueConversationUpdates, queueRealtime, withOrgRealtime } from "../../lib/realtime";
import { isSendingPausedForOrg } from "../channels/sending";
import { findChannel, findSendChannel } from "../channels/repo";
import { fail, newId, ok, type Result, type ServiceCtx } from "../contacts/result";
import { createRealPorts } from "./ai-ports";
import { hasAvailableProducts, sendProductPhotos } from "./catalog-port";
import type { ConversationsConfig } from "./config";
import { businessHoursFor } from "./inbound";
import { aiTextFor, toAiHours, trailingAgentCount } from "./logic";
import { addEvent, auditState, deliverOutbound } from "./outbound";
import { findVisibleConversation, loadActiveAgent, loadTags, type ActiveAgent, type ConvCtx, type ConversationRow } from "./queries";

const { conversations, messages, contacts, aiUsageLog, conversationSuggestions, copilotFeedback, organization, conversationAiEvents, appointmentTypes } = schema;

export type AiDeps = {
  db: Database;
  llm: LLMProvider;
  config: ConversationsConfig;
  /** Domínios que a IA pode citar além dos do conhecimento do agente (AGENTS_URL_ALLOWLIST). */
  urlAllowlist: readonly string[];
  now(): Date;
  /** Espera entre as novas tentativas do provedor de IA dentro do turno (testes injetam uma que não espera). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Reagenda (temporizador do processo) um turno adiado; a varredura de `ai_due_at` cobre reinício/queda. */
  scheduleRetry?: (organizationId: string, conversationId: string, delayMs: number) => void;
  log: { warn(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void };
};

const NO_AGENT = "00000000-0000-0000-0000-000000000000";
const HISTORY_LIMIT = 30;
const CLAIM_SLACK_MS = 250;

/**
 * Quando o provedor de IA falha de forma passageira mesmo após as novas tentativas dentro do turno, a conversa NÃO vai para a
 * equipe: o mesmo turno é re-agendado (`ai_due_at`) após 15 s, 45 s e 2 min. Se a 4ª tentativa também falhar, passa para a equipe.
 */
export const LLM_DEFER_DELAYS_MS = [15_000, 45_000, 120_000] as const;
/** Evento de auditoria de cada adiamento (contador durável: sobrevive a reinício, sem coluna nova). */
const LLM_DEFER_EVENT = "llm_unavailable";

/** Quantas vezes o turno desta mensagem do cliente já foi adiado (eventos desde a última mensagem do cliente). */
async function countLlmDeferrals(tx: Transaction, conv: Pick<ConversationRow, "id" | "organizationId" | "lastInboundAt">): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(conversationAiEvents)
    .where(
      and(
        eq(conversationAiEvents.organizationId, conv.organizationId),
        eq(conversationAiEvents.conversationId, conv.id),
        eq(conversationAiEvents.event, LLM_DEFER_EVENT),
        conv.lastInboundAt ? gte(conversationAiEvents.createdAt, conv.lastInboundAt) : undefined,
      ),
    );
  return row?.n ?? 0;
}

export function createAiRateLimiters(config: ConversationsConfig) {
  return {
    turns: createConversationRateLimiter({ max: config.CONVERSATIONS_AI_TURNS_PER_MINUTE, windowMs: 60_000 }),
    suggestions: createConversationRateLimiter({ max: config.CONVERSATIONS_SUGGESTIONS_PER_MINUTE, windowMs: 60_000 }),
  };
}
export type AiLimiters = ReturnType<typeof createAiRateLimiters>;

/** Agente "genérico" para sugerir resposta numa conversa sem agente ativo: só texto, sem ferramentas nem handoff. */
export function genericConfig(companyName: string): AgentRuntimeConfig {
  return {
    name: "Assistente",
    profile: { description: "Assistente de atendimento", tone: "friendly", companySummary: companyName },
    knowledge: { productsAndServices: "", faq: "" },
    behavior: { respondWhen: "always", handoffOnRequest: false, handoffOnComplaint: false, handoffOnUnknown: false, creativity: 3, maxConsecutiveMessages: 3 },
    followUp: { enabled: false, steps: [], respectBusinessHours: true },
    scheduling: { canBook: false, appointmentTypeIds: [] },
    advanced: { prompt: "", tools: [] },
  };
}

/** Tipos de atendimento que a IA pode oferecer: ativos e NÃO "só a equipe marca", sempre da empresa da conversa. */
async function loadBookableTypeIds(tx: Transaction, organizationId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: appointmentTypes.id, active: appointmentTypes.active, staffOnly: appointmentTypes.staffOnly })
    .from(appointmentTypes)
    .where(and(eq(appointmentTypes.organizationId, organizationId), eq(appointmentTypes.active, true)))
    .orderBy(asc(appointmentTypes.name));
  return bookableTypeIds(rows);
}

async function monthlyTokens(tx: Transaction, organizationId: string) {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${aiUsageLog.inputTokens} + ${aiUsageLog.outputTokens}), 0)::float8` })
    .from(aiUsageLog)
    .where(and(eq(aiUsageLog.organizationId, organizationId), gte(aiUsageLog.createdAt, sql`date_trunc('month', now())`)));
  return row?.total ?? 0;
}

async function remainingTokens(tx: Transaction, organizationId: string) {
  // orçamento vem de `plans.monthly_token_limit` (null = ilimitado), via a resolução única de plano
  const plan = await resolvePlan(tx, organizationId);
  return tokenBudget(await monthlyTokens(tx, organizationId), tokenLimitValue(plan)).remaining;
}

async function recordUsage(tx: Transaction, organizationId: string, agentId: string | null, conversationId: string, events: UsageEvent[]) {
  if (events.length === 0) return;
  await tx.insert(aiUsageLog).values(
    events.map((e) => ({
      id: newId(),
      organizationId,
      agentId,
      conversationId,
      purpose: e.purpose,
      provider: e.provider,
      model: e.model,
      inputTokens: e.usage.inputTokens,
      outputTokens: e.usage.outputTokens,
      cachedInputTokens: e.usage.cachedInputTokens ?? 0,
    })),
  );
}

type History = { chat: ChatMessage[]; lastCustomerText: string; triggerId: string | null };

async function loadHistory(tx: Transaction, conversationId: string): Promise<History> {
  const rows = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.direction, ["in", "out"])))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(HISTORY_LIMIT);
  const ordered = rows.reverse();
  const chat: ChatMessage[] = [];
  for (const m of ordered) {
    if (m.direction === "in") {
      const text = aiTextFor(m.kind, m.body);
      if (text) chat.push({ role: "customer", text });
    } else if (m.senderKind === "agent") {
      // foto do catálogo sem legenda não tem texto para a IA ler
      if (m.body.trim()) chat.push({ role: "agent", text: m.body });
    }
    else if (m.senderKind === "member" && m.status !== "failed") chat.push({ role: "human", text: m.body });
    // avisos automáticos e mensagens que falharam não entram na conversa que a IA enxerga
  }
  const inbound = ordered.filter((m) => m.direction === "in");
  const last = inbound[inbound.length - 1];
  return { chat, lastCustomerText: last?.body ?? "", triggerId: last?.id ?? null };
}

export type TurnReport = {
  ran: boolean;
  reason: string | null;
  mode: "live" | "copilot" | null;
  result: TurnResult | null;
  sent: number;
  suggestionId: string | null;
  /** Turno adiado por falha passageira do provedor de IA: tentará de novo em tantos ms (nada foi enviado). */
  retryInMs?: number;
};

const SKIPPED = (reason: string): TurnReport => ({ ran: false, reason, mode: null, result: null, sent: 0, suggestionId: null });

async function orgInfo(tx: Transaction, organizationId: string): Promise<ServiceCtx> {
  const [org] = await tx.select({ name: organization.name, tz: organization.timeZone }).from(organization).where(eq(organization.id, organizationId)).limit(1);
  return { organizationId, userId: "system", userName: "Sistema", timeZone: org?.tz ?? "America/Sao_Paulo", orgName: org?.name ?? "" };
}

/**
 * Atendimento ao vivo/copiloto NUNCA cai no LLM de demonstração em produção. Com provedor `fake`:
 * em dev/teste usa o demo explícito (a tela funciona sem chave); em produção o provedor "indisponível" faz o pipeline
 * passar a conversa para a equipe (`llm_error`). O boot também recusa `LLM_PROVIDER=fake` em produção (`assertLlmConfigForEnv`).
 */
export function llmForLiveTurn(llm: LLMProvider, env: { NODE_ENV?: string } = process.env): LLMProvider {
  if (llm.name !== "fake") return llm;
  if (env.NODE_ENV === "production") {
    return {
      name: "unavailable",
      async generate() {
        throw new LlmError("unknown", "Provedor de IA de demonstração não é permitido em produção.", false);
      },
    };
  }
  return createDemoLlm();
}

/** Roda um turno do runtime de IA para a conversa. `live` pode agir; `copilot` só devolve texto (nenhuma escrita). */
async function runTurn(
  tx: Transaction,
  deps: AiDeps,
  conv: ConversationRow,
  agent: ActiveAgent | null,
  mode: "live" | "copilot",
  now: Date,
  options: { deferLlmFailure?: boolean } = {},
): Promise<{ result: TurnResult; events: UsageEvent[]; history: History; config: AgentRuntimeConfig }> {
  const ctx = await orgInfo(tx, conv.organizationId);
  const history = await loadHistory(tx, conv.id);
  const [contact] = await tx.select({ name: contacts.name, phone: contacts.phone, email: contacts.email }).from(contacts).where(eq(contacts.id, conv.contactId)).limit(1);
  const { hours, timeZone } = await businessHoursFor(tx, conv.organizationId, conv.teamId);
  const stages = (await loadTags(tx, ctx)).filter((t) => t.funnelStage !== null).map((t) => t.name);
  // Agendar é função do sistema: com um agente atendendo, a agenda vem dos tipos ativos da empresa (config.scheduling e as
  // ferramentas de agenda em advanced.tools são legado e ignorados). Sem agente (assistente genérico) segue sem ferramentas.
  // O catálogo também é função do sistema: com produto disponível na empresa, o agente ganha as ferramentas de catálogo.
  const config = agent
    ? effectiveCatalogConfig(
        effectiveSchedulingConfig(agent.config, await loadBookableTypeIds(tx, conv.organizationId)),
        await hasAvailableProducts(tx, conv.organizationId),
      )
    : genericConfig(ctx.orgName);
  const events: UsageEvent[] = [];
  const minutesWaiting = conv.lastInboundAt ? Math.max(0, Math.floor((now.getTime() - conv.lastInboundAt.getTime()) / 60_000)) : 0;

  const ports = createRealPorts({ tx, db: deps.db, conv, agentName: agent?.name ?? "Assistente", ctx, lastCustomerText: history.lastCustomerText, now });
  const result = await runAgentTurn({
    scope: { organizationId: conv.organizationId, conversationId: conv.id, contactId: conv.contactId, agentId: agent?.id ?? NO_AGENT },
    mode,
    config,
    state: "ai_active",
    history: history.chat,
    llm: llmForLiveTurn(deps.llm),
    ports,
    now,
    // é no fuso da empresa que a IA fala dia e hora com o cliente (os horários da agenda chegam em UTC)
    timeZone,
    businessHours: toAiHours(hours, timeZone),
    urlAllowlist: [...deps.urlAllowlist],
    allowedTags: stages,
    consecutiveAgentMessages: trailingAgentCount(history.chat),
    minutesWaiting,
    budget: { remainingTokens: await remainingTokens(tx, conv.organizationId) },
    ownContactValues: [contact?.phone ?? "", contact?.email ?? ""].filter(Boolean),
    retry: deps.sleep ? { sleep: deps.sleep } : undefined,
    deferLlmFailure: options.deferLlmFailure,
    onUsage: (e) => {
      events.push(e);
    },
  });
  return { result, events, history, config };
}

/**
 * A resposta da IA a uma conversa cujo prazo de rajada venceu (`ai_due_at`). Idempotente e à prova de corrida:
 *  - lock `conv:{id}` (advisory, na transação): dois turnos da mesma conversa nunca andam juntos;
 *  - o "prazo" é reivindicado com UPDATE condicional: só quem zera `ai_due_at` responde;
 *  - o envio usa externalId determinístico (conversa + mensagem gatilho + índice), então reexecutar não duplica.
 */
export async function runDueAiTurn(deps: AiDeps, limiters: AiLimiters, organizationId: string, conversationId: string): Promise<TurnReport> {
  const now = deps.now();
  // "digitando…" da IA: avisa antes de chamar o modelo e sempre desliga no fim, DEPOIS do commit (a mensagem já está visível)
  let typingOn = false;
  let report: TurnReport;
  try {
    report = await withOrgRealtime(deps.db, organizationId, async (tx) => {
      const lockRows = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`conv:${conversationId}`}, 0)) as locked`);
      if (!lockRows[0]?.locked) return SKIPPED("locked");

      const [claimed] = await tx
        .update(conversations)
        .set({ aiDueAt: null, aiBurstStartedAt: null })
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.id, conversationId),
            isNotNull(conversations.aiDueAt),
            lte(conversations.aiDueAt, new Date(now.getTime() + CLAIM_SLACK_MS)),
          ),
        )
        .returning();
      if (!claimed) return SKIPPED("not_due");
      // já respondida (por pessoa ou por outro turno) ou fora do modo da IA
      // (aviso automático do canal não conta como resposta: só pessoa ou agente)
      if (claimed.lastReplyAt && claimed.lastInboundAt && claimed.lastReplyAt > claimed.lastInboundAt) return SKIPPED("already_answered");

      const agent = await loadActiveAgent(tx, organizationId, claimed.agentId);
      if (!agent) return SKIPPED("no_agent");

      const mode: "live" | "copilot" | null =
        claimed.mode === "ai" && claimed.status === "ai_active" ? "live" : claimed.mode === "copilot" && claimed.status !== "resolved" ? "copilot" : null;
      if (!mode) return SKIPPED("mode");

      if (mode === "live" && (await isSendingPausedForOrg(tx, now))) return SKIPPED("sending_paused");

      // anti-loop: muitos turnos por minuto na mesma conversa = chama a equipe em vez de gastar tokens
      if (!limiters.turns.allow(claimed.id)) {
        await tx.update(conversations).set({ status: "handoff_requested", waitingSince: now, updatedAt: now }).where(eq(conversations.id, claimed.id));
        await addEvent(tx, claimed, "Muitas mensagens em pouco tempo: conversa enviada para a equipe", now);
        await auditState(tx, claimed, { from: claimed.status, to: "handoff_requested", event: "handoff_requested", actor: "system", reason: "limite de turnos por minuto" });
        queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: claimed.id, reason: "handoff" });
        queueRealtime(tx, organizationId, { type: "home.invalidate" });
        return SKIPPED("rate_limited");
      }

      if (mode === "live") {
        typingOn = true;
        publishRealtime(organizationId, { type: "typing", conversationId: claimed.id, actor: "agent", active: true });
      }
      // falha passageira do provedor de IA: quantas vezes este turno já foi adiado (durável, ver LLM_DEFER_DELAYS_MS)
      const deferrals = mode === "live" ? await countLlmDeferrals(tx, claimed) : 0;
      const { result, events, history } = await runTurn(tx, deps, claimed, agent, mode, now, { deferLlmFailure: deferrals < LLM_DEFER_DELAYS_MS.length });
      await recordUsage(tx, organizationId, agent.id, claimed.id, events);

      if (mode === "live" && result.skipped === SKIP_LLM_UNAVAILABLE) {
        // nada vai ao cliente e o estado não muda (continua ai_active): só re-arma o MESMO turno e audita o adiamento
        const delayMs = LLM_DEFER_DELAYS_MS[Math.min(deferrals, LLM_DEFER_DELAYS_MS.length - 1)]!;
        await tx.update(conversations).set({ aiDueAt: new Date(now.getTime() + delayMs) }).where(eq(conversations.id, claimed.id));
        await tx.insert(conversationAiEvents).values({
          id: newId(),
          organizationId,
          conversationId: claimed.id,
          agentId: agent.id,
          fromState: claimed.status,
          toState: claimed.status,
          event: LLM_DEFER_EVENT,
          actor: "system",
          reason: `IA indisponível no momento; nova tentativa em ${Math.round(delayMs / 1000)} s (adiamento ${deferrals + 1} de ${LLM_DEFER_DELAYS_MS.length})`,
          createdAt: now,
        });
        deps.log.warn("conversations.ai.llm_deferred", { conversationId: claimed.id, deferral: deferrals + 1, retryInMs: delayMs });
        return { ran: true, reason: SKIP_LLM_UNAVAILABLE, mode, result, sent: 0, suggestionId: null, retryInMs: delayMs };
      }

      if (mode === "copilot") {
        const body = result.messages.join("\n\n").trim();
        if (!body) return { ran: true, reason: result.skipped, mode, result, sent: 0, suggestionId: null };
        const suggestionId = newId();
        await tx.insert(conversationSuggestions).values({ id: suggestionId, organizationId, conversationId: claimed.id, agentId: agent.id, body, createdBy: null });
        queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: claimed.id, reason: "other" });
        return { ran: true, reason: null, mode, result, sent: 0, suggestionId };
      }

      // ---- modo IA: envia (cada parte com externalId determinístico), audita e ajusta o estado
      const channel = await findSendChannel(tx, organizationId, claimed.channelId);
      const [contact] = await tx.select({ phone: contacts.phone, instagram: contacts.instagram }).from(contacts).where(eq(contacts.id, claimed.contactId)).limit(1);
      let sent = 0;
      for (const [i, text] of result.messages.entries()) {
        const delivered = await deliverOutbound(tx, {
          conv: claimed,
          channelName: channel?.name ?? "do cliente",
          to: contact?.phone ?? contact?.instagram ?? null,
          kind: "text",
          body: text,
          media: null,
          sender: { kind: "agent", id: agent.id, name: agent.name },
          externalId: `ai:${claimed.id}:${history.triggerId ?? "x"}:${i}`,
          countsAsReply: true,
          now,
          // "digitando…" no WhatsApp do cliente proporcional ao texto (provedor sem presença ignora)
          typingMs: typingMsForText(text),
        });
        if (delivered.ok) sent++;
      }
      // fotos de produto que a IA pediu (send_product_photos): seguem os textos, cada uma como mensagem de imagem do agente
      if (result.photoRequests.length > 0) {
        sent += await sendProductPhotos(tx, {
          conv: claimed,
          channelName: channel?.name ?? "do cliente",
          to: contact?.phone ?? contact?.instagram ?? null,
          agent: { id: agent.id, name: agent.name },
          productIds: result.photoRequests.map((r) => r.productId),
          triggerId: history.triggerId,
          now,
          log: deps.log,
        });
      }

      for (const t of result.transitions) {
        await auditState(tx, claimed, { from: t.from, to: t.to, event: t.event, actor: t.actor, reason: t.reason ?? null, userId: t.userId ?? null });
      }
      if (result.handoff) {
        const priorityByKind = { complaint: "high", urgency: "urgent" } as const;
        const raise = priorityByKind[result.handoff.kind as keyof typeof priorityByKind];
        await tx
          .update(conversations)
          .set({
            status: "handoff_requested",
            waitingSince: sql`coalesce(${conversations.waitingSince}, ${now.toISOString()}::timestamptz)`,
            ...(raise && claimed.priority !== "urgent" ? { priority: raise } : {}),
            updatedAt: now,
          })
          .where(eq(conversations.id, claimed.id));
      }
      if (result.handoff) {
        queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: claimed.id, reason: "handoff" });
        queueRealtime(tx, organizationId, { type: "home.invalidate" });
      }
      return { ran: true, reason: result.skipped, mode, result, sent, suggestionId: null };
    });
  } finally {
    if (typingOn) publishRealtime(organizationId, { type: "typing", conversationId, actor: "agent", active: false });
  }
  // depois do commit: temporizador do processo para o turno adiado (a varredura de `ai_due_at` cobre queda/reinício)
  if (report.retryInMs !== undefined) deps.scheduleRetry?.(organizationId, conversationId, report.retryInMs);
  return report;
}

// ── "sugerir resposta" (pedido por uma pessoa) ──────────────────────────────

export async function suggestReply(
  tx: Transaction,
  deps: AiDeps,
  limiters: AiLimiters,
  ctx: ConvCtx,
  conversationId: string,
): Promise<Result<ReplySuggestion, "not_found" | "rate_limited" | "no_suggestion">> {
  const conv = await findVisibleConversation(tx, ctx, conversationId);
  if (!conv) return fail("not_found", "Conversa não encontrada.");
  if (!limiters.suggestions.allow(`${ctx.userId}:${conv.id}`)) return fail("rate_limited", "Muitos pedidos de sugestão. Espere um minuto e tente de novo.");

  const now = deps.now();
  const agent = await loadActiveAgent(tx, ctx.organizationId, conv.agentId);
  const { result, events } = await runTurn(tx, deps, conv, agent, "copilot", now);
  await recordUsage(tx, ctx.organizationId, agent?.id ?? null, conv.id, events);
  const body = result.messages.join("\n\n").trim();
  if (!body) return fail("no_suggestion", "Não consegui sugerir uma resposta agora. Escreva a sua.");
  const id = newId();
  await tx.insert(conversationSuggestions).values({ id, organizationId: ctx.organizationId, conversationId: conv.id, agentId: agent?.id ?? null, body, createdBy: ctx.userId });
  return ok({ id, body });
}

/** Avaliação útil/ruim: guarda na sugestão e alimenta o feedback do Copiloto (Agentes lê `copilot_feedback`, §4.4). */
export async function rateSuggestion(tx: Transaction, ctx: ConvCtx, suggestionId: string, rating: SuggestionRating): Promise<Result<null, "not_found">> {
  const [row] = await tx
    .select()
    .from(conversationSuggestions)
    .where(and(eq(conversationSuggestions.organizationId, ctx.organizationId), eq(conversationSuggestions.id, suggestionId)))
    .limit(1);
  if (!row) return fail("not_found", "Sugestão não encontrada.");
  // quem não pode ver a conversa não avalia sugestão dela
  if (!(await findVisibleConversation(tx, ctx, row.conversationId))) return fail("not_found", "Sugestão não encontrada.");
  const first = row.rating === null;
  await tx.update(conversationSuggestions).set({ rating, ratedAt: new Date() }).where(eq(conversationSuggestions.id, row.id));
  if (first) {
    await tx.insert(copilotFeedback).values({
      id: newId(),
      organizationId: ctx.organizationId,
      agentId: row.agentId,
      conversationId: row.conversationId,
      messageId: null,
      verdict: rating,
      suggestion: row.body,
      reason: null,
      createdBy: ctx.userId,
    });
  }
  return ok(null);
}

// ── varredura (o que um worker faria) ───────────────────────────────────────

/** Respostas de IA cujo prazo venceu e que o temporizador do processo não cumpriu (reinício, queda, lock). */
export async function sweepDueAiTurns(deps: AiDeps, limiters: AiLimiters, organizationId: string, limit = 20): Promise<number> {
  const due = await withOrg(deps.db, organizationId, (tx) =>
    tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.organizationId, organizationId), isNotNull(conversations.aiDueAt), lte(conversations.aiDueAt, deps.now())))
      .orderBy(asc(conversations.aiDueAt))
      .limit(limit),
  );
  let ran = 0;
  for (const row of due) {
    try {
      const report = await runDueAiTurn(deps, limiters, organizationId, row.id);
      if (report.ran) ran++;
    } catch (error) {
      deps.log.error("conversations.ai.turn_failed", { conversationId: row.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return ran;
}

/**
 * Encerramento por inatividade (Ajustes → Atendimento): conversa que ficou só com a IA (sem pessoa) e parada há N dias é
 * resolvida pela IA. Conversas com pessoa ou na fila nunca são fechadas sozinhas.
 */
export async function closeInactiveAiConversations(deps: AiDeps, organizationId: string): Promise<number> {
  return withOrgRealtime(deps.db, organizationId, async (tx) => {
    const [settings] = await tx
      .select({ inactivityClose: schema.organizationSettings.inactivityClose })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, organizationId))
      .limit(1);
    const cfg = (settings?.inactivityClose ?? { enabled: true, days: 3 }) as { enabled?: boolean; days?: number };
    if (!cfg.enabled || !cfg.days) return 0;
    const now = deps.now();
    const cutoff = new Date(now.getTime() - cfg.days * 86_400_000);
    const closed = await tx
      .update(conversations)
      .set({ status: "resolved", resolvedBy: "ai", resolvedAt: now, waitingSince: null, aiDueAt: null, updatedAt: now })
      .where(
        and(
          eq(conversations.organizationId, organizationId),
          eq(conversations.status, "ai_active"),
          eq(conversations.mode, "ai"),
          sql`${conversations.assigneeId} is null`,
          ne(conversations.lastMessageDirection, "in"),
          lte(conversations.lastMessageAt, cutoff),
        ),
      )
      .returning();
    for (const conv of closed) {
      await addEvent(tx, conv, `Conversa encerrada por inatividade (${cfg.days} dias sem resposta)`, now);
      await auditState(tx, conv, { from: "ai_active", to: "resolved", event: "resolved", actor: "system", reason: "inatividade" });
    }
    queueConversationUpdates(tx, organizationId, closed.map((conv) => conv.id), "resolved");
    if (closed.length > 0) queueRealtime(tx, organizationId, { type: "home.invalidate" });
    return closed.length;
  });
}

/** Empresas com resposta de IA vencida (função SECURITY DEFINER `dz_orgs_with_due_conversations`; só devolve ids). */
export async function discoverOrgsWithDueTurns(db: Database, limit = 100): Promise<string[]> {
  const rows = await db.execute<{ organization_id: string }>(sql`select organization_id from public.dz_orgs_with_due_conversations(${limit})`);
  return rows.map((r) => r.organization_id);
}

/** Varredura de respostas vencidas: só as empresas que têm trabalho (antes: as 500 primeiras empresas, sem ordem). */
export async function sweepAll(deps: AiDeps, limiters: AiLimiters, maxOrgs = 100): Promise<{ turns: number }> {
  const orgs = await discoverOrgsWithDueTurns(deps.db, maxOrgs);
  let turns = 0;
  for (const organizationId of orgs) {
    try {
      turns += await sweepDueAiTurns(deps, limiters, organizationId);
    } catch (error) {
      deps.log.error("conversations.sweep.failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { turns };
}

/**
 * Encerramento por inatividade de TODAS as empresas, em páginas por id (cursor): nenhuma empresa fica de fora e a
 * memória não cresce. Barato por empresa (um UPDATE); rode com frequência baixa (a cada hora).
 */
export async function sweepInactivity(deps: AiDeps, pageSize = 200): Promise<{ closed: number }> {
  let closed = 0;
  let after: string | null = null;
  for (;;) {
    const page: { id: string }[] = await deps.db
      .select({ id: organization.id })
      .from(organization)
      .where(after ? sql`${organization.id} > ${after}` : undefined)
      .orderBy(asc(organization.id))
      .limit(pageSize);
    if (page.length === 0) break;
    for (const org of page) {
      try {
        closed += await closeInactiveAiConversations(deps, org.id);
      } catch (error) {
        deps.log.error("conversations.inactivity.failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    }
    after = page[page.length - 1]?.id ?? null;
    if (page.length < pageSize) break;
  }
  return { closed };
}
