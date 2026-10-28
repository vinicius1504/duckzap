import { describe, expect, it } from "vitest";
import {
  createAnthropicLlm,
  createFakeLlm,
  createGeminiLlm,
  createOpenAiLlm,
  LlmError,
  withFallback,
  type AnthropicResponse,
  type GenerateRequest,
  type LLMProvider,
} from "../src";

/**
 * Suíte de CONTRATO do LLMProvider: roda igual contra todos os adaptadores. É a prova de que o produto é neutro
 * de provedor: trocar Claude por ChatGPT/Gemini não muda nada acima da interface. Sem rede.
 * Cada "harness" sabe fazer o provedor responder de um jeito (texto, tool call, erro HTTP).
 */
type Behavior = { kind: "text"; text: string } | { kind: "tool"; name: string; input: Record<string, unknown> } | { kind: "http"; status: number };
type Harness = { name: string; make(behavior: Behavior): LLMProvider };

const models = { smart: "m-smart", fast: "m-fast" };

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status, name: "APIError" });
}

const anthropicHarness: Harness = {
  name: "anthropic",
  make(b) {
    return createAnthropicLlm({
      models,
      timeoutMs: 1000,
      client: {
        messages: {
          async create(): Promise<AnthropicResponse> {
            if (b.kind === "http") throw httpError(b.status);
            return {
              model: "claude-x",
              stop_reason: b.kind === "tool" ? "tool_use" : "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
              content: b.kind === "tool" ? [{ type: "tool_use", id: "tu_1", name: b.name, input: b.input }] : [{ type: "text", text: b.text }],
            };
          },
        },
      },
    });
  },
};

function jsonFetch(b: Behavior, shape: "openai" | "gemini"): typeof fetch {
  return async () => {
    if (b.kind === "http") return new Response("{}", { status: b.status });
    const body =
      shape === "openai"
        ? {
            model: "gpt-x",
            choices: [
              {
                finish_reason: b.kind === "tool" ? "tool_calls" : "stop",
                message: b.kind === "tool" ? { content: null, tool_calls: [{ id: "call_1", function: { name: b.name, arguments: JSON.stringify(b.input) } }] } : { content: b.text },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }
        : {
            modelVersion: "gemini-x",
            candidates: [{ finishReason: "STOP", content: { parts: b.kind === "tool" ? [{ functionCall: { name: b.name, args: b.input } }] : [{ text: b.text }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const harnesses: Harness[] = [
  {
    name: "fake",
    make(b) {
      return createFakeLlm(() => {
        if (b.kind === "http") throw new LlmError(b.status === 429 ? "rate_limited" : b.status === 401 ? "auth" : "invalid_request", "x", b.status === 429);
        if (b.kind === "tool") return { toolCalls: [{ id: "tu_1", name: b.name, input: b.input }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } };
        return { text: b.text, usage: { inputTokens: 10, outputTokens: 5 } };
      });
    },
  },
  anthropicHarness,
  { name: "openai (sem chave real)", make: (b) => createOpenAiLlm({ apiKey: "k", models, timeoutMs: 1000, fetch: jsonFetch(b, "openai") }) },
  { name: "gemini (sem chave real)", make: (b) => createGeminiLlm({ apiKey: "k", models, timeoutMs: 1000, fetch: jsonFetch(b, "gemini") }) },
];

const request: GenerateRequest = {
  tier: "smart",
  system: "Você é um assistente.",
  messages: [
    { role: "user", content: "oi" },
    { role: "assistant", content: [{ type: "text", text: "..." }, { type: "tool_call", id: "tu_0", name: "search_knowledge", input: { query: "x" } }] },
    { role: "user", content: [{ type: "tool_result", callId: "tu_0", output: "achei" }] },
  ],
  tools: [{ name: "search_knowledge", description: "busca", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
  meta: { organizationId: "org", purpose: "teste" },
};

describe.each(harnesses)("contrato LLMProvider: $name", (h) => {
  it("devolve texto, uso e identificação do provedor/modelo", async () => {
    const out = await h.make({ kind: "text", text: "olá" }).generate(request);
    expect(out.text).toBe("olá");
    expect(out.toolCalls).toEqual([]);
    expect(out.stopReason).toBe("end");
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(5);
    expect(typeof out.model).toBe("string");
    expect(typeof out.provider).toBe("string");
  });

  it("traduz chamada de ferramenta para o formato neutro (aceitando tool_call/tool_result no histórico)", async () => {
    const out = await h.make({ kind: "tool", name: "search_knowledge", input: { query: "preço" } }).generate(request);
    expect(out.stopReason).toBe("tool_use");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: "search_knowledge", input: { query: "preço" } });
    expect(out.toolCalls[0]?.id).toBeTruthy();
  });

  it("429 vira LlmError repetível e dispara o modelo de reserva", async () => {
    const primary = h.make({ kind: "http", status: 429 });
    await expect(primary.generate(request)).rejects.toMatchObject({ name: "LlmError", code: "rate_limited", retryable: true });
    const backup = createFakeLlm(() => "reserva");
    const out = await withFallback(primary, backup).generate(request);
    expect(out.text).toBe("reserva");
  });

  it("401 vira LlmError de autenticação, NÃO repetível, e não cai no fallback", async () => {
    const primary = h.make({ kind: "http", status: 401 });
    await expect(primary.generate(request)).rejects.toMatchObject({ code: "auth", retryable: false });
    await expect(withFallback(primary, createFakeLlm(() => "reserva")).generate(request)).rejects.toBeInstanceOf(LlmError);
  });
});

describe("adaptadores sem chave", () => {
  it("openai e gemini recusam sem LLM_API_KEY com erro de auth", async () => {
    await expect(createOpenAiLlm({ models, timeoutMs: 100 }).generate(request)).rejects.toMatchObject({ code: "auth" });
    await expect(createGeminiLlm({ models, timeoutMs: 100 }).generate(request)).rejects.toMatchObject({ code: "auth" });
    await expect(createAnthropicLlm({ models, timeoutMs: 100 }).generate(request)).rejects.toMatchObject({ code: "auth" });
  });
});

import { assertLlmConfigForEnv } from "../src";

describe("assertLlmConfigForEnv", () => {
  it("recusa fake em produção; aceita em dev/test", () => {
    expect(() => assertLlmConfigForEnv({ NODE_ENV: "production", LLM_PROVIDER: "fake" })).toThrow(/fake/);
    expect(() => assertLlmConfigForEnv({ NODE_ENV: "production" })).toThrow(/fake/);
    expect(() => assertLlmConfigForEnv({ NODE_ENV: "production", LLM_PROVIDER: "gemini", LLM_FALLBACK_PROVIDER: "fake", LLM_API_KEY: "k" })).toThrow(/FALLBACK/);
    expect(() => assertLlmConfigForEnv({ NODE_ENV: "production", LLM_PROVIDER: "gemini" })).toThrow(/LLM_API_KEY/);
    expect(() => assertLlmConfigForEnv({ NODE_ENV: "production", LLM_PROVIDER: "gemini", LLM_API_KEY: "k" })).not.toThrow();
    expect(() => assertLlmConfigForEnv({ NODE_ENV: "development", LLM_PROVIDER: "fake" })).not.toThrow();
    expect(() => assertLlmConfigForEnv({ LLM_PROVIDER: "fake" })).not.toThrow();
  });
});
