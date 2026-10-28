import { LlmError, modelFor, type GenerateResult, type LLMProvider, type LlmMessage, type ModelNames } from "../llm";
import { registerProvider } from "../registry";
import { postJson } from "./http";

/**
 * Adaptador Gemini (generateContent) via fetch, sem dependência nova.
 * ATENÇÃO: NÃO TESTADO COM CHAVE REAL — só o mapeamento é coberto por teste.
 * Gemini não devolve id de chamada de ferramenta: geramos `nome#posição` e, na volta, usamos o nome.
 */
type Part = Record<string, unknown>;

export function toGeminiContents(messages: LlmMessage[]) {
  const callNames = new Map<string, string>();
  return messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
    const parts: Part[] = m.content.map((p) => {
      if (p.type === "text") return { text: p.text };
      if (p.type === "tool_call") {
        callNames.set(p.id, p.name);
        return { functionCall: { name: p.name, args: p.input } };
      }
      return {
        functionResponse: { name: callNames.get(p.callId) ?? p.callId, response: { output: p.output, ...(p.isError ? { error: true } : {}) } },
      };
    });
    return { role, parts };
  });
}

export type GeminiResponse = {
  modelVersion?: string;
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
};

export function fromGeminiResponse(data: GeminiResponse): GenerateResult {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const toolCalls = parts.flatMap((p, i) =>
    p.functionCall ? [{ id: `${p.functionCall.name}#${i}`, name: p.functionCall.name, input: p.functionCall.args ?? {} }] : [],
  );
  const reason = candidate?.finishReason;
  return {
    text: parts.map((p) => p.text ?? "").join(""),
    toolCalls,
    stopReason: toolCalls.length
      ? "tool_use"
      : reason === "MAX_TOKENS"
        ? "max_tokens"
        : reason === "SAFETY" || reason === "PROHIBITED_CONTENT"
          ? "refusal"
          : reason === "STOP"
            ? "end"
            : "other",
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      cachedInputTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
    },
    model: data.modelVersion ?? "gemini",
    provider: "gemini",
  };
}

export function createGeminiLlm(options: {
  apiKey?: string;
  models: ModelNames;
  timeoutMs: number;
  baseUrl?: string;
  fetch?: typeof fetch;
}): LLMProvider {
  return {
    name: "gemini",
    async generate(request) {
      if (!options.apiKey) throw new LlmError("auth", "LLM_API_KEY não configurada para o provedor gemini.", false);
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: toGeminiContents(request.messages),
        ...(request.tools?.length
          ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] }
          : {}),
        ...(request.maxOutputTokens ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } } : {}),
      };
      const model = encodeURIComponent(modelFor(options.models, request.tier));
      const data = await postJson(
        `${options.baseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta/models/${model}:generateContent`,
        { "x-goog-api-key": options.apiKey },
        body,
        request.timeoutMs ?? options.timeoutMs,
        request.signal,
        options.fetch,
      );
      return fromGeminiResponse(data as GeminiResponse);
    },
  };
}

registerProvider("gemini", (config) => createGeminiLlm(config));
