import type { GenerateRequest, GenerateResult, LLMProvider } from "../src/llm";
import {
  createInMemoryPorts,
  runAgentTurn,
  type AgentRuntimeConfig,
  type ChatMessage,
  type ConversationState,
  type FakeState,
  type HandoffKind,
  type Intent,
  type ProductInfo,
  type TurnResult,
} from "../src/agents";

/**
 * Harness dos evals (§4.4). Um cenário é uma conversa roteirizada + o que DEVE valer (handoff, tools, guardrails).
 * Roda com o LLM fake roteirizado (determinístico, no CI) e, quando houver LLM_API_KEY, contra o provedor real
 * (ver real.eval.test.ts) — por isso as asserções são sobre comportamento, não sobre texto exato.
 */

export function sampleConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    name: "Duck",
    profile: { description: "Atende clientes da clínica", tone: "friendly", companySummary: "Clínica odontológica Casa Alvorada, em Pinheiros." },
    knowledge: {
      productsAndServices: "Limpeza dental: 45 minutos, avaliação inclusa.\nClareamento a laser: a partir de R$ 600,00.\nRestauração: o valor depende da avaliação.",
      faq: "Atendemos Unimed e Odontoprev.\nHorário: segunda a sexta, das 8h às 18h.\nSite: https://casaalvorada.com.br",
    },
    behavior: {
      respondWhen: "always",
      handoffOnRequest: true,
      handoffOnComplaint: true,
      handoffOnUnknown: true,
      creativity: 3,
      maxConsecutiveMessages: 6,
    },
    followUp: { enabled: false, steps: [], respectBusinessHours: true },
    scheduling: { canBook: true, appointmentTypeIds: ["apt_limpeza", "apt_avaliacao"] },
    advanced: {
      prompt: "Nunca invente preços.",
      tools: ["search_knowledge", "list_available_slots", "book_appointment", "reschedule_appointment", "request_human", "add_tag"],
    },
    ...overrides,
  };
}

export type ModelStep = Partial<GenerateResult> | string;

export type Scenario = {
  id: string;
  description: string;
  config?: AgentRuntimeConfig;
  state?: ConversationState;
  chunks?: { id: string; documentName: string | null; text: string }[];
  /** Produtos DISPONÍVEIS do catálogo fictício. */
  products?: ProductInfo[];
  history: ChatMessage[];
  /** Resposta do roteador (fast). Padrão: question com confiança 0.9. */
  router?: { intent: Intent; confidence: number } | string;
  /** Comportamento (roteirizado) do modelo smart, por chamada. Omitir = o modelo nunca deveria ser chamado. */
  model?: ModelStep[];
  allowedTags?: string[];
  consecutiveAgentMessages?: number;
  budget?: { remainingTokens: number };
  mode?: "live" | "copilot" | "simulator";
  expect: {
    handoff?: HandoffKind | null;
    intent?: Intent;
    skipped?: string | null;
    optOut?: boolean;
    /** tools que DEVEM ter sido chamadas (nesta ordem relativa) */
    tools?: string[];
    /** tools que NÃO podem ter sido chamadas */
    noTools?: string[];
    blocked?: string[];
    /** chamadas esperadas ao modelo smart */
    smartCalls?: number;
    routerCalls?: number;
    messagesNonEmpty?: boolean;
    noMessages?: boolean;
    flags?: string[];
    /** verificação livre sobre o estado fake e o resultado */
    check?: (r: TurnResult, fake: FakeState, requests: GenerateRequest[]) => void;
  };
};

export function scriptedLlm(scenario: Scenario) {
  const requests: GenerateRequest[] = [];
  let smart = 0;
  let router = 0;
  const llm: LLMProvider = {
    name: "fake",
    async generate(request) {
      requests.push(request);
      const base = { toolCalls: [], stopReason: "end" as const, usage: { inputTokens: 100, outputTokens: 20 }, model: `fake-${request.tier}`, provider: "fake" };
      if (request.meta?.purpose === "agent_router") {
        router++;
        const r = scenario.router ?? { intent: "question", confidence: 0.9 };
        return { ...base, text: typeof r === "string" ? r : JSON.stringify(r) };
      }
      const step = scenario.model?.[smart++];
      if (step === undefined) throw new Error(`Cenário ${scenario.id}: o modelo smart foi chamado além do roteiro.`);
      const partial = typeof step === "string" ? { text: step } : step;
      return { ...base, text: "", ...partial };
    },
  };
  return { llm, requests, counts: () => ({ smart, router }) };
}

export async function runScenario(scenario: Scenario, llmOverride?: LLMProvider) {
  const { llm, requests, counts } = scriptedLlm(scenario);
  const { ports, state } = createInMemoryPorts({ chunks: scenario.chunks, products: scenario.products, now: () => new Date("2026-10-26T12:00:00Z") });
  const result = await runAgentTurn({
    scope: { organizationId: "org_test", conversationId: "conv_test", contactId: "contact_test", agentId: "agt_test" },
    mode: scenario.mode ?? "live",
    config: scenario.config ?? sampleConfig(),
    state: scenario.state ?? "ai_active",
    history: scenario.history,
    llm: llmOverride ?? llm,
    ports,
    now: new Date("2026-10-26T12:00:00Z"),
    nonce: "nonce_fixo_para_teste",
    allowedTags: scenario.allowedTags,
    consecutiveAgentMessages: scenario.consecutiveAgentMessages,
    budget: scenario.budget,
  });
  return { result, fake: state, requests, counts };
}
