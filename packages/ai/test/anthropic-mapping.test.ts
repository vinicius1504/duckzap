import { describe, expect, it } from "vitest";
import { buildAnthropicBody, createAnthropicLlm, createLlm, fromAnthropicResponse, llmEnvSchema, mapAnthropicError, type AnthropicResponse } from "../src";

// Mapeamento do adaptador Anthropic com respostas GRAVADAS (fixtures no formato real da Messages API). Sem rede.

const recordedText: AnthropicResponse = {
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "Atendemos sim: Unimed e Odontoprev." }],
  usage: { input_tokens: 120, output_tokens: 18, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
};

const recordedToolUse: AnthropicResponse = {
  model: "claude-sonnet-5-5",
  stop_reason: "tool_use",
  content: [
    { type: "text", text: "Vou ver os horários." },
    { type: "tool_use", id: "toolu_01A", name: "list_available_slots", input: { type_id: "apt_limpeza", from_date: "2026-10-26", to_date: "2026-10-30" } },
  ],
  usage: { input_tokens: 300, output_tokens: 60, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 },
};

describe("anthropic: resposta → formato neutro", () => {
  it("texto + uso com cache (entrada total inclui leitura de cache)", () => {
    const r = fromAnthropicResponse(recordedText);
    expect(r).toMatchObject({ text: "Atendemos sim: Unimed e Odontoprev.", stopReason: "end", provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(r.usage).toEqual({ inputTokens: 1020, outputTokens: 18, cachedInputTokens: 900 });
  });

  it("tool_use vira toolCalls e stopReason tool_use", () => {
    const r = fromAnthropicResponse(recordedToolUse);
    expect(r.stopReason).toBe("tool_use");
    expect(r.text).toBe("Vou ver os horários.");
    expect(r.toolCalls).toEqual([{ id: "toolu_01A", name: "list_available_slots", input: { type_id: "apt_limpeza", from_date: "2026-10-26", to_date: "2026-10-30" } }]);
  });

  it("mapeia max_tokens, refusal e desconhecidos", () => {
    expect(fromAnthropicResponse({ ...recordedText, stop_reason: "max_tokens" }).stopReason).toBe("max_tokens");
    expect(fromAnthropicResponse({ ...recordedText, stop_reason: "refusal" }).stopReason).toBe("refusal");
    expect(fromAnthropicResponse({ ...recordedText, stop_reason: "pause_turn" }).stopReason).toBe("other");
  });
});

describe("anthropic: pedido neutro → Messages API", () => {
  const body = buildAnthropicBody(
    {
      tier: "fast",
      system: "SISTEMA FIXO",
      temperature: 0.7,
      messages: [
        { role: "user", content: "oi" },
        { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "a", input: { x: 1 } }] },
        { role: "user", content: [{ type: "tool_result", callId: "t1", output: "erro", isError: true }] },
      ],
      tools: [
        { name: "a", description: "A", inputSchema: { type: "object", properties: {} } },
        { name: "b", description: "B", inputSchema: { type: "object", properties: {} } },
      ],
    },
    "claude-haiku-5-5",
    1024,
  );

  it("cache_control no bloco system estável e na última ferramenta", () => {
    expect(body.system).toEqual([{ type: "text", text: "SISTEMA FIXO", cache_control: { type: "ephemeral" } }]);
    expect(body.tools?.[0]).not.toHaveProperty("cache_control");
    expect(body.tools?.[1]).toHaveProperty("cache_control");
  });

  it("não envia temperature/top_p/top_k (400 desde 21/10/2026)", () => {
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("traduz mensagens, tool_use e tool_result com is_error; effort por nível", () => {
    expect(body.messages).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "a", input: { x: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "erro", is_error: true }] },
    ]);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.model).toBe("claude-haiku-5-5");
  });

  it("nível → modelo vem da configuração (padrão Sonnet 5.5 / Haiku 5.5)", async () => {
    const seen: string[] = [];
    const llm = createAnthropicLlm({
      models: { smart: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
      timeoutMs: 1000,
      client: { messages: { create: async (b) => { seen.push(String(b.model)); return recordedText; } } },
    });
    await llm.generate({ tier: "smart", system: "s", messages: [{ role: "user", content: "x" }] });
    await llm.generate({ tier: "fast", system: "s", messages: [{ role: "user", content: "x" }] });
    expect(seen).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    const env = llmEnvSchema.parse({});
    expect([env.LLM_MODEL_SMART, env.LLM_MODEL_FAST]).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
  });
});

describe("anthropic: erros", () => {
  const err = (status: number, name = "APIError") => Object.assign(new Error("x"), { status, name });
  it.each([
    [429, "rate_limited", true],
    [529, "overloaded", true],
    [503, "overloaded", true],
    [401, "auth", false],
    [403, "auth", false],
    [400, "invalid_request", false],
  ])("HTTP %i → %s (repetível: %s)", (status, code, retryable) => {
    expect(mapAnthropicError(err(status))).toMatchObject({ code, retryable });
  });
  it("timeout e falha de conexão são repetíveis", () => {
    expect(mapAnthropicError(err(0, "APIConnectionTimeoutError"))).toMatchObject({ code: "timeout", retryable: true });
    expect(mapAnthropicError(err(0, "APIConnectionError"))).toMatchObject({ code: "timeout", retryable: true });
  });
  it("erro desconhecido não é repetível", () => {
    expect(mapAnthropicError(new Error("boom"))).toMatchObject({ code: "unknown", retryable: false });
  });
  it("o registro cria o adaptador via createLlm (sem importar o adaptador no produto)", () => {
    const llm = createLlm(llmEnvSchema.parse({ LLM_PROVIDER: "anthropic", LLM_API_KEY: "k" }));
    expect(llm.name).toBe("anthropic");
    expect(createLlm(llmEnvSchema.parse({ LLM_PROVIDER: "openai", LLM_API_KEY: "k" })).name).toBe("openai");
    expect(createLlm(llmEnvSchema.parse({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k", LLM_FALLBACK_PROVIDER: "fake" })).name).toBe("gemini+fake");
  });
});
