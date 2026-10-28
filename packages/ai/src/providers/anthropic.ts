import Anthropic from "@anthropic-ai/sdk";
import {
  LlmError,
  modelFor,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type LlmMessage,
  type ModelNames,
  type ModelTier,
} from "../llm";
import { registerProvider } from "../registry";

/**
 * Adaptador Claude (provedor padrão do produto). Traduz o formato neutro de `llm.ts` para a Messages API.
 *
 * Decisões (API de out/2026):
 * - NÃO enviamos `temperature`/`top_p`/`top_k`: desde 21/10/2026 a API devolve 400 para esses campos em todos os
 *   modelos. A "criatividade" do agente vira instrução no prompt (ver agents/prompt.ts), não parâmetro.
 * - Profundidade de raciocínio via `output_config.effort` (fast = low, smart = medium); sem `thinking` explícito.
 * - Cache de prompt no bloco `system` (estável) e nas ferramentas (renderizadas antes do system).
 */

export type AnthropicBlock = { type: string; [key: string]: unknown };
export type AnthropicResponse = {
  content: AnthropicBlock[];
  stop_reason: string | null;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
};
/** Parte do cliente oficial que usamos — permite injetar um cliente gravado nos testes (sem rede). */
export type AnthropicLike = {
  messages: {
    create(body: Record<string, unknown>, options?: { signal?: AbortSignal; timeout?: number }): Promise<AnthropicResponse>;
  };
};

export type AnthropicOptions = {
  apiKey?: string;
  models: ModelNames;
  timeoutMs: number;
  client?: AnthropicLike;
  maxOutputTokens?: number;
  /** Profundidade de raciocínio por nível (menos raciocínio = menos tokens de saída = mais barato). */
  effort?: Partial<Record<ModelTier, Effort>>;
};

export type Effort = "low" | "medium" | "high";
const EFFORT: Record<ModelTier, Effort> = { fast: "low", smart: "medium", best: "medium" };

export function toAnthropicMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    if (m.role === "user") {
      return {
        role: "user",
        content: m.content.map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : { type: "tool_result", tool_use_id: p.callId, content: p.output, ...(p.isError ? { is_error: true } : {}) },
        ),
      };
    }
    return {
      role: "assistant",
      content: m.content.map((p) =>
        p.type === "text" ? { type: "text", text: p.text } : { type: "tool_use", id: p.id, name: p.name, input: p.input },
      ),
    };
  });
}

export function buildAnthropicBody(request: GenerateRequest, model: string, maxTokens: number, effort: Partial<Record<ModelTier, Effort>> = {}) {
  const tools = request.tools?.map((t, i, all) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    // breakpoint na última ferramenta: o conjunto de ferramentas costuma ser estável por agente
    ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
  return {
    model,
    max_tokens: request.maxOutputTokens ?? maxTokens,
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: toAnthropicMessages(request.messages),
    ...(tools && tools.length ? { tools } : {}),
    output_config: { effort: effort[request.tier] ?? EFFORT[request.tier] },
  };
}

const STOP: Record<string, GenerateResult["stopReason"]> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

export function fromAnthropicResponse(response: AnthropicResponse): GenerateResult {
  let text = "";
  const toolCalls: GenerateResult["toolCalls"] = [];
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const raw = block.input;
      const input: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
      toolCalls.push({ id: block.id, name: block.name, input });
    }
  }
  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
  return {
    text,
    toolCalls,
    stopReason: STOP[response.stop_reason ?? ""] ?? "other",
    usage: {
      // neutro: total de entrada (inclui cache); `cachedInputTokens` é o que veio do cache
      inputTokens: response.usage.input_tokens + cacheRead + cacheWrite,
      outputTokens: response.usage.output_tokens,
      cachedInputTokens: cacheRead,
    },
    model: response.model,
    provider: "anthropic",
  };
}

/** 429/529/timeout/conexão/5xx → repetível; 401/403 → auth; 400/422 → pedido inválido. */
export function mapAnthropicError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const e: { status?: unknown; name?: unknown; message?: unknown } = typeof error === "object" && error !== null ? error : {};
  const status = typeof e.status === "number" ? e.status : undefined;
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "Falha na chamada ao Claude.";
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError" || name === "AbortError" || name === "APIConnectionError") {
    return new LlmError("timeout", message, true, { cause: error });
  }
  if (status === 429) return new LlmError("rate_limited", message, true, { cause: error });
  if (status === 529) return new LlmError("overloaded", message, true, { cause: error });
  if (status !== undefined && status >= 500) return new LlmError("overloaded", message, true, { cause: error });
  if (status === 401 || status === 403) return new LlmError("auth", message, false, { cause: error });
  if (status === 400 || status === 404 || status === 413 || status === 422) return new LlmError("invalid_request", message, false, { cause: error });
  return new LlmError("unknown", message, false, { cause: error });
}

export function createAnthropicLlm(options: AnthropicOptions): LLMProvider {
  let client = options.client;
  const getClient = (): AnthropicLike => {
    if (client) return client;
    if (!options.apiKey) throw new LlmError("auth", "LLM_API_KEY não configurada para o provedor anthropic.", false);
    // o cliente oficial já tem retry próprio; limitamos a 1 para o fallback entre provedores agir rápido
    const real = new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 1 });
    client = {
      messages: {
        create: async (body, opts) => {
          const response: unknown = await real.messages.create(body as never, opts);
          return response as AnthropicResponse;
        },
      },
    };
    return client;
  };
  return {
    name: "anthropic",
    async generate(request) {
      try {
        const model = modelFor(options.models, request.tier);
        const body = buildAnthropicBody(request, model, options.maxOutputTokens ?? 1024, options.effort);
        const response = await getClient().messages.create(body, { signal: request.signal, timeout: request.timeoutMs ?? options.timeoutMs });
        return fromAnthropicResponse(response);
      } catch (error) {
        throw mapAnthropicError(error);
      }
    },
  };
}

registerProvider("anthropic", (config) => createAnthropicLlm(config));
