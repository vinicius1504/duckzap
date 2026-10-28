import { LlmError, modelFor, type GenerateResult, type LLMProvider, type LlmMessage, type ModelNames } from "../llm";
import { registerProvider } from "../registry";
import { postJson } from "./http";

/**
 * Adaptador OpenAI (Chat Completions) via fetch, sem dependência nova.
 * ATENÇÃO: NÃO TESTADO COM CHAVE REAL — só o mapeamento é coberto por teste (mesma suíte de contrato).
 * Os nomes de modelo vêm de LLM_MODEL_SMART/LLM_MODEL_FAST (configure os modelos OpenAI desejados).
 */
type OpenAiMessage = Record<string, unknown>;

export function toOpenAiMessages(system: string, messages: LlmMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === "user") {
      for (const p of m.content) {
        if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.callId, content: p.output });
        else out.push({ role: "user", content: p.text });
      }
    } else {
      const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      const calls = m.content.flatMap((p) =>
        p.type === "tool_call" ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }] : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

export type OpenAiResponse = {
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

export function fromOpenAiResponse(data: OpenAiResponse): GenerateResult {
  const choice = data.choices?.[0];
  const toolCalls = (choice?.message?.tool_calls ?? []).map((c) => {
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(c.function.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = { ...parsed };
    } catch {
      // argumentos inválidos viram {} e falham na validação Zod da ferramenta
    }
    return { id: c.id, name: c.function.name, input };
  });
  const reason = choice?.finish_reason;
  return {
    text: choice?.message?.content ?? "",
    toolCalls,
    stopReason:
      reason === "tool_calls" ? "tool_use" : reason === "length" ? "max_tokens" : reason === "content_filter" ? "refusal" : reason === "stop" ? "end" : "other",
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: data.model ?? "openai",
    provider: "openai",
  };
}

export function createOpenAiLlm(options: {
  apiKey?: string;
  models: ModelNames;
  timeoutMs: number;
  baseUrl?: string;
  /** Nome nos logs/uso (provedores compatíveis com a API da OpenAI, como o Groq). */
  name?: string;
  /** Campos extras do corpo conforme o modelo (ex.: esforço de raciocínio nos modelos que "pensam" antes de responder). */
  extraBody?: (model: string) => Record<string, unknown>;
  fetch?: typeof fetch;
}): LLMProvider {
  const name = options.name ?? "openai";
  return {
    name,
    async generate(request) {
      if (!options.apiKey) throw new LlmError("auth", `Chave de API não configurada para o provedor ${name}.`, false);
      const body = {
        model: modelFor(options.models, request.tier),
        ...(options.extraBody?.(modelFor(options.models, request.tier)) ?? {}),
        messages: toOpenAiMessages(request.system, request.messages),
        ...(request.tools?.length
          ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
          : {}),
        ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
      };
      const data = await postJson(
        `${options.baseUrl ?? "https://api.openai.com"}/v1/chat/completions`,
        { authorization: `Bearer ${options.apiKey}` },
        body,
        request.timeoutMs ?? options.timeoutMs,
        request.signal,
        options.fetch,
      );
      const result = fromOpenAiResponse(data as OpenAiResponse);
      return name === "openai" ? result : { ...result, provider: name };
    },
  };
}

registerProvider("openai", (config) => createOpenAiLlm(config));
// Groq fala o mesmo protocolo (chat/completions com ferramentas) em outro endereço
registerProvider("groq", (config) => createOpenAiLlm({
    ...config,
    baseUrl: "https://api.groq.com/openai",
    name: "groq",
    // modelos gpt-oss raciocinam antes de responder e gastam o limite de tokens nisso: esforço baixo mantém respostas curtas (roteador)
    extraBody: (model) => (model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
  }));
