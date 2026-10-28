/**
 * Interface única de IA do produto (INSTRUCTIONS §2 e §4). Agentes, simulador, roteador,
 * variações de campanha e assistente de ajuda falam SÓ com isto, nunca com um SDK.
 * Trocar Claude por ChatGPT/Gemini = novo adaptador em `providers/` + variáveis de ambiente.
 *
 * Regras do contrato:
 * - Formato neutro de mensagens, ferramentas e resultado; cada adaptador traduz de/para o provedor.
 * - Modelos por "nível" (`fast` = classificação/roteamento/resumos, `smart` = conversa do agente),
 *   nunca por nome de modelo no código do produto. O nome real vem da configuração.
 * - Conteúdo do cliente entra sempre como dado delimitado em `messages` (role "user"),
 *   nunca concatenado em `system` (anti prompt injection, §4.3).
 */

/**
 * `fast` = classificar/resumir/ajuda; `smart` = conversa com o cliente e simulador; `best` = tarefas raras em que a qualidade
 * importa mais que o custo (gerador de perfil do agente). Sem modelo próprio, `best` usa o de `smart`.
 */
export type ModelTier = "fast" | "smart" | "best";

export type ModelNames = { smart: string; fast: string; best?: string };
export function modelFor(models: ModelNames, tier: ModelTier): string {
  return tier === "best" ? (models.best ?? models.smart) : models[tier];
}

export type TextPart = { type: "text"; text: string };
export type ToolCallPart = { type: "tool_call"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultPart = { type: "tool_result"; callId: string; output: string; isError?: boolean };

export type LlmMessage =
  | { role: "user"; content: string | (TextPart | ToolResultPart)[] }
  | { role: "assistant"; content: string | (TextPart | ToolCallPart)[] };

/** Ferramenta em JSON Schema (formato aceito por Claude, OpenAI e Gemini com pequenas adaptações). */
export type LlmTool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type GenerateRequest = {
  tier: ModelTier;
  /** Instruções do sistema (fixas: prompt do agente + regras). Bloco estável, bom para cache. */
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  /** 0 a 1. O agente expõe isto como "criatividade". */
  temperature?: number;
  maxOutputTokens?: number;
  /** Prazo desta chamada em ms (substitui o padrão do provedor, `LLM_TIMEOUT_MS`). Para saídas longas, como o gerador de perfil. */
  timeoutMs?: number;
  /** Para auditoria e orçamento de tokens por empresa/conversa (§4.3). Não vai ao provedor. */
  meta?: { organizationId: string; conversationId?: string; purpose: string };
  signal?: AbortSignal;
};

export type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

export type GenerateResult = {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: TokenUsage;
  /** Nome real do modelo usado (log/custos). */
  model: string;
  provider: string;
};

export type LlmErrorCode = "rate_limited" | "timeout" | "overloaded" | "invalid_request" | "auth" | "unknown";

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    /** Vale tentar de novo (ou cair no modelo de reserva)? */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

export interface LLMProvider {
  readonly name: string;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}
