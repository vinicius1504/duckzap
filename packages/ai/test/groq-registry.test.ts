import { describe, expect, it, vi } from "vitest";
import { createLlm, createOpenAiLlm, llmEnvSchema } from "../src";

const okResponse = (model: string) =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: "oi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

describe("provedor groq (protocolo OpenAI em outro endereço)", () => {
  it("usa o endereço do Groq, a chave dele e se identifica como groq", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse("openai/gpt-oss-120b"));
    const llm = createOpenAiLlm({
      apiKey: "chave-de-teste",
      models: { smart: "openai/gpt-oss-120b", fast: "openai/gpt-oss-20b" },
      timeoutMs: 1000,
      baseUrl: "https://api.groq.com/openai",
      name: "groq",
      extraBody: (model) => (model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      fetch: fetchMock as unknown as typeof fetch,
    });
    const out = await llm.generate({ tier: "fast", system: "s", messages: [{ role: "user", content: "oi" }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "openai/gpt-oss-20b", reasoning_effort: "low" });
    expect(out.provider).toBe("groq");
  });

  it("modelo sem raciocínio não recebe o campo extra", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse("outro"));
    const llm = createOpenAiLlm({
      apiKey: "k",
      models: { smart: "outro/modelo", fast: "outro/modelo" },
      timeoutMs: 1000,
      name: "groq",
      extraBody: (model) => (model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      fetch: fetchMock as unknown as typeof fetch,
    });
    await llm.generate({ tier: "smart", system: "s", messages: [{ role: "user", content: "oi" }] });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).not.toHaveProperty("reasoning_effort");
  });

  it("aceita groq como principal e a reserva com chave e modelos próprios", () => {
    const env = llmEnvSchema.parse({
      LLM_PROVIDER: "groq",
      LLM_API_KEY: "a",
      LLM_MODEL_SMART: "openai/gpt-oss-120b",
      LLM_MODEL_FAST: "openai/gpt-oss-20b",
      LLM_FALLBACK_PROVIDER: "gemini",
      LLM_FALLBACK_API_KEY: "b",
      LLM_FALLBACK_MODEL_SMART: "gemini-2.5-flash-lite",
      LLM_FALLBACK_MODEL_FAST: "gemini-2.5-flash-lite",
    });
    expect(createLlm(env).name).toBe("groq+gemini");
  });

  it("sem chave própria da reserva, ela herda a do principal (comportamento anterior)", () => {
    const env = llmEnvSchema.parse({ LLM_PROVIDER: "gemini", LLM_API_KEY: "a", LLM_FALLBACK_PROVIDER: "openai" });
    expect(createLlm(env).name).toBe("gemini+openai");
  });
});

describe("esforço de raciocínio configurável (provedor Claude)", () => {
  it("usa low/medium por padrão e aceita sobrescrever por nível", async () => {
    const { buildAnthropicBody } = await import("../src");
    const req = { tier: "smart" as const, system: "s", messages: [{ role: "user" as const, content: "oi" }] };
    expect(buildAnthropicBody(req, "m", 100).output_config.effort).toBe("medium");
    expect(buildAnthropicBody(req, "m", 100, { smart: "low" }).output_config.effort).toBe("low");
    expect(buildAnthropicBody({ ...req, tier: "fast" }, "m", 100, { smart: "low" }).output_config.effort).toBe("low");
  });

  it("LLM_EFFORT_* é validado pelo esquema de ambiente", () => {
    expect(llmEnvSchema.parse({ LLM_EFFORT_SMART: "low" }).LLM_EFFORT_SMART).toBe("low");
    expect(() => llmEnvSchema.parse({ LLM_EFFORT_SMART: "ultra" })).toThrow();
  });
});

describe("nível `best` (tarefas raras de qualidade, como o gerador de perfil)", () => {
  it("sem modelo próprio, usa o de smart; com LLM_MODEL_BEST, usa o dele", async () => {
    const { modelFor } = await import("../src");
    expect(modelFor({ smart: "s", fast: "f" }, "best")).toBe("s");
    expect(modelFor({ smart: "s", fast: "f", best: "b" }, "best")).toBe("b");
    expect(modelFor({ smart: "s", fast: "f", best: "b" }, "fast")).toBe("f");
  });

  it("o corpo enviado ao Claude usa o esforço do nível best (médio por padrão, configurável)", async () => {
    const { buildAnthropicBody } = await import("../src");
    const req = { tier: "best" as const, system: "s", messages: [{ role: "user" as const, content: "oi" }] };
    expect(buildAnthropicBody(req, "m", 100).output_config.effort).toBe("medium");
    expect(buildAnthropicBody(req, "m", 100, { best: "high" }).output_config.effort).toBe("high");
  });

  it("LLM_MODEL_BEST e LLM_EFFORT_BEST são validados pelo esquema de ambiente", () => {
    const env = llmEnvSchema.parse({ LLM_MODEL_BEST: "claude-sonnet-5-5", LLM_EFFORT_BEST: "high" });
    expect(env.LLM_MODEL_BEST).toBe("claude-sonnet-5-5");
    expect(() => llmEnvSchema.parse({ LLM_EFFORT_BEST: "ultra" })).toThrow();
  });
});
