import { randomUUID } from "node:crypto";
import { LlmError, type GenerateResult, type LlmMessage } from "../llm";
import { rankProducts } from "./catalog";
import { checkOutput } from "./guardrails";
import { hasKnowledgeOverlap, isSmallTalk } from "./knowledge";
import { isRetryableLlmError, withLlmRetry } from "./llm-retry";
import { DEFAULT_TIME_ZONE, formatNow } from "./local-time";
import { buildDataBlock, buildRulesBlock, buildSystemPrompt, TURN_INSTRUCTION, wrapToolResult } from "./prompt";
import { applyRules, classifyIntent, intentFromVerdict, MIN_ROUTER_CONFIDENCE } from "./router";
import { aiMayRespond, canTransition, transition, type ConversationEvent } from "./state-machine";
import { isWithinBusinessHours, looksLikeInjection, toWhatsappFormat } from "./text";
import { buildToolDefs, executeTool, toLlmTools, type ToolContext } from "./tools";
import {
  MAX_PHOTO_PRODUCTS_PER_TURN,
  SKIP_LLM_UNAVAILABLE,
  type AppointmentInfo,
  type ContactInfo,
  type HandoffKind,
  type Intent,
  type KnowledgeHit,
  type ToolTrace,
  type TurnInput,
  type TurnResult,
} from "./types";

/**
 * Pipeline de um turno (§4.1): regras determinísticas → roteador (fast) → conhecimento → especialista (smart + tools)
 * → guardrails de saída → envio | handoff. O MESMO código serve ao agente ao vivo, ao Copiloto e ao Simulador;
 * só mudam os efeitos: `mode !== "live"` ⇒ nenhuma escrita (tools em dry-run) e nenhuma transição de estado.
 */

const MAX_TOOL_STEPS = 5;
// inclui o raciocínio do modelo (Claude pensa antes de responder): teto baixo cortava a resposta e virava transferência
const MAX_OUTPUT_TOKENS = 2000;

const COURTESY: Record<HandoffKind, string> = {
  customer_request: "Claro! Vou chamar alguém da equipe para continuar com você.",
  complaint: "Sinto muito por isso. Já estou chamando uma pessoa da equipe para te ajudar agora.",
  urgency: "Entendi que é urgente. Já estou chamando uma pessoa da equipe para te ajudar agora.",
  unknown_knowledge: "Não tenho essa informação aqui e não quero te passar nada errado. Vou chamar alguém da equipe.",
  low_confidence: "Não tenho certeza de que entendi direitinho. Vou chamar alguém da equipe para te ajudar.",
  tool_failures: "Tive um problema para concluir isso por aqui. Vou chamar alguém da equipe para te ajudar.",
  guardrail: "Prefiro que alguém da equipe confirme isso com você. Já estou chamando.",
  model_request: "Vou pedir para alguém da equipe continuar esse atendimento com você.",
  budget: "Vou pedir para alguém da equipe continuar esse atendimento com você.",
  message_limit: "",
  llm_error: "Vou pedir para alguém da equipe continuar esse atendimento com você.",
};

const OPT_OUT_REPLY = "Pronto, você não vai mais receber mensagens nossas. Se precisar, é só chamar por aqui.";

class BudgetExceeded extends Error {}

export async function runAgentTurn(input: TurnInput): Promise<TurnResult> {
  const now = input.now ?? new Date();
  const nonce = input.nonce ?? randomUUID().replace(/-/g, "");
  const live = input.mode === "live";
  const dryRun = !live;
  const { config, scope } = input;

  const result: TurnResult = {
    messages: [],
    intent: null,
    handoff: null,
    toolCalls: [],
    skipped: null,
    optOut: false,
    transitions: [],
    state: input.state,
    blocked: [],
    flags: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    photoRequests: [],
  };

  // ---------- utilidades do turno ----------
  const apply = (event: ConversationEvent, actor: "customer" | "ai" | "system", reason?: string) => {
    if (!live || !canTransition(result.state, event)) return;
    const record = transition(result.state, event, { actor, at: now, reason });
    if (record.from !== record.to) result.transitions.push(record);
    result.state = record.to;
  };
  const skip = (reason: string) => {
    result.skipped = reason;
    return result;
  };
  let budgetLeft = input.budget?.remainingTokens;
  const llmCall = async <T extends Pick<GenerateResult, "usage" | "model" | "provider">>(purpose: string, run: () => Promise<T>) => {
    if (budgetLeft !== undefined && budgetLeft <= 0) throw new BudgetExceeded();
    // falha passageira do provedor (429, sobrecarga, timeout): tenta de novo dentro do turno. Só a tentativa que deu
    // certo entra no uso/orçamento (tentativas que falharam não consumiram tokens).
    const out = await withLlmRetry(run, input.retry);
    const used = out.usage.inputTokens + out.usage.outputTokens;
    if (budgetLeft !== undefined) budgetLeft -= used;
    result.usage.inputTokens += out.usage.inputTokens;
    result.usage.outputTokens += out.usage.outputTokens;
    await input.onUsage?.({ purpose, provider: out.provider, model: out.model, usage: out.usage });
    return out;
  };
  /**
   * Falha passageira que persistiu depois das novas tentativas: NÃO passa para a equipe nem escreve ao cliente.
   * Devolve `skipped = "llm_unavailable"` e quem chamou re-agenda o turno. Só vale ao vivo e se o turno ainda não
   * gravou nada (agendamento, etiqueta…): refazer o turno do zero repetiria a escrita, então nesse caso cai no handoff.
   */
  let wroteData = false;
  const canDefer = (error: unknown) => live && input.deferLlmFailure !== false && !wroteData && isRetryableLlmError(error);
  const defer = () => {
    result.messages = [];
    result.handoff = null;
    result.transitions = [];
    result.toolCalls = [];
    result.photoRequests = [];
    result.state = input.state;
    result.flags.push(SKIP_LLM_UNAVAILABLE);
    return skip(SKIP_LLM_UNAVAILABLE);
  };
  const traced = new Set<string>();
  const handoff = async (kind: HandoffKind, reason: string, options: { message?: string; alreadyRequested?: boolean } = {}) => {
    result.handoff = { kind, reason };
    // foto só acompanha uma resposta aprovada do modelo (ou o pedido de equipe dele); mensagem padrão de cortesia vai sozinha
    if (kind !== "model_request") result.photoRequests = [];
    const text = options.message ?? COURTESY[kind];
    result.messages = text ? [text] : [];
    if (!options.alreadyRequested) {
      if (live) await input.ports.conversations.requestHuman(scope, reason);
      if (!traced.has("request_human")) {
        result.toolCalls.push({
          tool: "request_human",
          args: { reason },
          result: live ? "Conversa enviada para a equipe" : "Conversa enviada para a fila da equipe (teste)",
          ok: true,
        });
      }
    }
    apply("handoff_requested", "ai", reason);
    return result;
  };

  // ---------- 1. entrada ----------
  const customerTexts: string[] = [];
  for (let i = input.history.length - 1; i >= 0; i--) {
    const m = input.history[i];
    if (!m || m.role !== "customer") break;
    customerTexts.unshift(m.text);
  }
  if (customerTexts.length === 0) return skip("no_customer_message");
  const joined = customerTexts.join("\n");
  if (customerTexts.some(looksLikeInjection)) result.flags.push("prompt_injection_suspected");

  apply("customer_message", "customer");

  // ---------- 2. regras determinísticas ----------
  const verdict = applyRules(customerTexts);

  // opt-out é lei (LGPD/WhatsApp): vale em qualquer estado
  if (verdict.kind === "opt_out") {
    result.intent = "opt_out";
    result.optOut = true;
    if (live) await input.ports.conversations.markOptOut(scope);
    if (!aiMayRespond(input.state)) return skip(input.state);
    result.messages = [OPT_OUT_REPLY];
    apply("ai_replied", "ai", "opt_out");
    return result;
  }

  if (!aiMayRespond(input.state)) return skip(input.state);

  if (live) {
    if (config.behavior.respondWhen === "outside_hours" && input.businessHours && isWithinBusinessHours(now, input.businessHours)) {
      return skip("within_business_hours");
    }
    if (config.behavior.respondWhen === "no_reply_5min" && (input.minutesWaiting ?? 0) < 5) return skip("waiting_for_team");
  }

  if ((input.consecutiveAgentMessages ?? 0) >= config.behavior.maxConsecutiveMessages) {
    result.intent = result.intent ?? "question";
    return handoff("message_limit", "Limite de mensagens seguidas sem resposta do cliente.");
  }
  if (budgetLeft !== undefined && budgetLeft <= 0) {
    return handoff("budget", "Orçamento de IA da empresa esgotado no período.");
  }

  if (verdict.kind === "urgency") {
    result.intent = "complaint";
    return handoff("urgency", "Cliente relatou urgência.");
  }
  if (verdict.kind === "complaint" && config.behavior.handoffOnComplaint) {
    result.intent = "complaint";
    return handoff("complaint", "Reclamação ou insatisfação do cliente.");
  }
  if (verdict.kind === "human" && config.behavior.handoffOnRequest) {
    result.intent = "human";
    return handoff("customer_request", "Cliente pediu para falar com uma pessoa.");
  }
  if (verdict.kind === "spam") {
    result.intent = "spam";
    return skip("spam");
  }

  // ---------- 3. roteador (fast) ----------
  let intent: Intent | null = intentFromVerdict(verdict);
  // cumprimento/agradecimento/"teste": não precisa de classificador (e ele dava confiança baixa, transferindo o cliente à toa)
  if (!intent && isSmallTalk(customerTexts[customerTexts.length - 1] ?? "")) intent = "question";
  if (!intent) {
    try {
      const d = await llmCall("agent_router", () =>
        classifyIntent({
          llm: input.llm,
          history: input.history,
          nonce,
          organizationId: scope.organizationId,
          conversationId: scope.conversationId,
        }),
      );
      intent = d.intent;
      if (d.confidence < MIN_ROUTER_CONFIDENCE) {
        result.intent = intent;
        return handoff("low_confidence", "O roteador não teve confiança na intenção do cliente.");
      }
    } catch (error) {
      if (error instanceof BudgetExceeded) return handoff("budget", "Orçamento de IA da empresa esgotado no período.");
      if (canDefer(error)) return defer();
      return handoff("llm_error", "IA indisponível no momento.");
    }
  }
  result.intent = intent;

  if (intent === "spam") return skip("spam");
  if (intent === "opt_out") {
    result.optOut = true;
    if (live) await input.ports.conversations.markOptOut(scope);
    result.messages = [OPT_OUT_REPLY];
    apply("ai_replied", "ai", "opt_out");
    return result;
  }
  if (intent === "complaint" && config.behavior.handoffOnComplaint) return handoff("complaint", "Reclamação ou insatisfação do cliente.");
  // pedido EXPLÍCITO de pessoa já foi tratado pelas regras fixas acima. Se só o classificador (modelo pequeno) achou que era um
  // pedido, o agente decide: ele sabe esclarecer antes e só chama a equipe se o cliente quis mesmo uma pessoa. Transferir direto
  // aqui mandava para a equipe perguntas sobre o próprio serviço ("vocês transferem para um humano?").
  if (intent === "human") intent = "question";

  // ---------- 4. contexto e conhecimento ----------
  let contact: ContactInfo | null = null;
  let appointments: AppointmentInfo[] = [];
  try {
    contact = await input.ports.contacts.getContact(scope);
    if (config.scheduling.canBook) appointments = await input.ports.agenda.listContactAppointments(scope);
  } catch {
    // contexto é opcional; segue sem ele
  }

  // "Informações da empresa" (campo novo) + produtos/FAQ legados dos agentes antigos: tudo é conhecimento estático (aterramento e links)
  const companyInfo = config.knowledge.companyInfo?.trim();
  const staticKnowledge = `${companyInfo ? `${companyInfo}\n` : ""}${config.knowledge.productsAndServices}\n${config.knowledge.faq}`;
  const knowledgeTexts: string[] = [staticKnowledge];
  let retrieved: KnowledgeHit[] = [];
  const needsGrounding = (intent === "question" || intent === "buy") && !isSmallTalk(customerTexts[customerTexts.length - 1] ?? "");
  if (needsGrounding) {
    try {
      retrieved = await input.ports.knowledge.search(scope, joined.slice(-300), 4);
    } catch {
      retrieved = [];
    }
    knowledgeTexts.push(...retrieved.map((h) => h.text));
    let grounded = retrieved.length > 0 || hasKnowledgeOverlap(joined, staticKnowledge);
    // o catálogo também é conhecimento: pergunta sobre um produto cadastrado não é "fora do conhecimento"
    if (!grounded && config.catalog?.enabled) {
      try {
        grounded = rankProducts(joined.slice(-300), await input.ports.catalog.listAvailable(scope)).length > 0;
      } catch {
        grounded = false;
      }
    }
    if (!grounded && config.behavior.handoffOnUnknown) {
      return handoff("unknown_knowledge", "Pergunta fora do conhecimento do agente.");
    }
  }

  // ---------- 5. especialista (smart + tools) ----------
  const typeNames = new Map<string, string>();
  if (config.scheduling.canBook) {
    for (const id of config.scheduling.appointmentTypeIds) {
      try {
        const t = await input.ports.agenda.getType(scope, id);
        if (t) typeNames.set(id, t.name);
      } catch {
        // nome é só enfeite do prompt
      }
    }
  }
  const timeZone = input.timeZone ?? input.businessHours?.timeZone ?? DEFAULT_TIME_ZONE;
  const toolCtx: ToolContext = {
    scope,
    config,
    ports: input.ports,
    dryRun,
    now,
    timeZone,
    businessHours: input.businessHours,
    allowedTags: input.allowedTags ?? [],
    onKnowledge: (hits) => knowledgeTexts.push(...hits.map((h) => h.text)),
    requestPhotos: (productId) => {
      if (result.photoRequests.some((r) => r.productId === productId)) return "duplicate";
      if (result.photoRequests.length >= MAX_PHOTO_PRODUCTS_PER_TURN) return "limit";
      result.photoRequests.push({ productId });
      return "added";
    },
  };
  const defs = buildToolDefs(toolCtx, typeNames);
  const tools = toLlmTools(defs);
  const system = buildSystemPrompt(config, { allowedTags: input.allowedTags });
  const block = buildDataBlock({
    nonce,
    history: input.history,
    summary: input.conversationSummary,
    contact,
    appointments,
    retrieved,
    // data e hora no fuso da empresa, com dia da semana: é daqui que a IA entende "amanhã" e "sexta"
    nowLabel: formatNow(now, timeZone),
    timeZone,
    typeNames,
  });
  const messages: LlmMessage[] = [{ role: "user", content: `${block}\n\n${TURN_INSTRUCTION}` }];
  const purpose = input.mode === "live" ? "agent_reply" : input.mode === "copilot" ? "agent_copilot" : "agent_simulator";

  let finalText = "";
  let failures = 0;
  let requested: string | null = null;
  let finished = false;
  try {
    for (let step = 0; step < MAX_TOOL_STEPS && !finished; step++) {
      const out = await llmCall(purpose, () =>
        input.llm.generate({
          tier: "smart",
          system,
          messages,
          tools,
          temperature: config.behavior.creativity / 10,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          meta: { organizationId: scope.organizationId, conversationId: scope.conversationId, purpose },
        }),
      );
      if (out.stopReason === "refusal") {
        return handoff("guardrail", "O modelo recusou responder.");
      }
      if (out.toolCalls.length === 0) {
        if (out.stopReason === "max_tokens") return handoff("guardrail", "Resposta do modelo ficou incompleta.");
        finalText = out.text;
        finished = true;
        break;
      }
      messages.push({
        role: "assistant",
        content: [
          ...(out.text ? [{ type: "text" as const, text: out.text }] : []),
          ...out.toolCalls.map((c) => ({ type: "tool_call" as const, id: c.id, name: c.name, input: c.input })),
        ],
      });
      const parts: { type: "tool_result"; callId: string; output: string; isError?: boolean }[] = [];
      for (const call of out.toolCalls) {
        const outcome = await executeTool(defs, toolCtx, call.name, call.input);
        if (outcome.trace) {
          result.toolCalls.push(outcome.trace satisfies ToolTrace);
          traced.add(outcome.trace.tool);
          const tool = outcome.trace.tool;
          if (live && defs.some((d) => d.name === tool && d.write)) wroteData = true;
        }
        failures = outcome.ok ? 0 : failures + 1;
        if (outcome.handoffReason && !requested) requested = outcome.handoffReason;
        parts.push({ type: "tool_result", callId: call.id, output: wrapToolResult(outcome.output, nonce), ...(outcome.ok ? {} : { isError: true }) });
        if (failures >= 2) break;
      }
      messages.push({ role: "user", content: parts });
      if (failures >= 2) return handoff("tool_failures", "Duas falhas seguidas ao usar ferramentas.", { alreadyRequested: traced.has("request_human") && requested !== null });
      if (requested) {
        finalText = out.text;
        finished = true;
      }
    }
  } catch (error) {
    if (error instanceof BudgetExceeded) return handoff("budget", "Orçamento de IA da empresa esgotado no período.");
    if (canDefer(error)) return defer();
    if (error instanceof LlmError) return handoff("llm_error", "IA indisponível no momento.");
    return handoff("llm_error", "Falha inesperada ao gerar a resposta.");
  }

  // ---------- 6. saída ----------
  const previousAgent = input.history.filter((m) => m.role === "agent").map((m) => m.text);
  const corpus = [...knowledgeTexts, ...previousAgent].join("\n");
  // links: só do que a empresa escreveu (conhecimento estático, prompt, resumo); trechos de documentos recuperados NÃO valem
  const linkCorpus = [staticKnowledge, config.advanced.prompt, config.profile.companySummary, ...previousAgent].join("\n");
  if (knowledgeTexts.slice(1).some(looksLikeInjection)) result.flags.push("knowledge_injection_suspected");
  const own = [...(input.ownContactValues ?? []), contact?.phone ?? "", contact?.email ?? ""].filter(Boolean);
  const formattedText = toWhatsappFormat(finalText); // sem símbolos de Markdown no WhatsApp
  const checked = formattedText.trim()
    ? checkOutput({
        text: formattedText,
        knowledgeCorpus: corpus,
        linkCorpus,
        urlAllowlist: input.urlAllowlist ?? [],
        ownContactValues: own,
        systemPrompt: system,
        internalRules: buildRulesBlock(config),
        nonce,
        maxConsecutiveMessages: config.behavior.maxConsecutiveMessages,
        alreadySent: input.consecutiveAgentMessages ?? 0,
      })
    : null;

  if (requested) {
    // o modelo pediu a equipe: manda a resposta dele só se passar nos guardrails; senão, a mensagem padrão
    if (checked && !checked.ok) result.blocked.push(checked.code);
    return handoff("model_request", requested, {
      alreadyRequested: true,
      message: checked?.ok ? checked.messages.join("\n\n") : COURTESY.model_request,
    });
  }
  if (!checked) {
    return handoff("guardrail", "O modelo não produziu resposta.");
  }
  if (!checked.ok) {
    result.blocked.push(checked.code);
    if (checked.code === "message_limit") return handoff("message_limit", checked.reason);
    return handoff("guardrail", checked.reason);
  }

  result.messages = checked.messages;
  apply("ai_replied", "ai");
  return result;
}
