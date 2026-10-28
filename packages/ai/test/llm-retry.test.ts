import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  buildSystemPrompt,
  checkOutput,
  createInMemoryPorts,
  LlmError,
  runAgentTurn,
  SKIP_LLM_UNAVAILABLE,
  withLlmRetry,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type TurnInput,
  type UsageEvent,
} from "../src";
import { sampleConfig } from "../evals/harness";

const ok = (text: string, over: Partial<GenerateResult> = {}): GenerateResult => ({
  text,
  toolCalls: [],
  stopReason: "end",
  usage: { inputTokens: 100, outputTokens: 20 },
  model: "fake",
  provider: "flaky",
  ...over,
});

/** LLM que falha as `n` primeiras chamadas de cada finalidade com o erro dado e depois responde normalmente. */
function flakyLlm(opts: { routerFails?: number; smartFails?: number; error?: () => Error; script?: GenerateResult[] }) {
  const calls = { router: 0, smart: 0, routerAttempts: 0, smartAttempts: 0 };
  const mk = opts.error ?? (() => new LlmError("rate_limited", "429 RESOURCE_EXHAUSTED", true));
  const script = opts.script ?? [ok("Atendemos sim: Unimed e Odontoprev.")];
  const llm: LLMProvider = {
    name: "flaky",
    async generate(request: GenerateRequest) {
      if (request.meta?.purpose === "agent_router") {
        calls.routerAttempts++;
        if (calls.routerAttempts <= (opts.routerFails ?? 0)) throw mk();
        calls.router++;
        return ok(JSON.stringify({ intent: "question", confidence: 0.9 }));
      }
      calls.smartAttempts++;
      if (calls.smartAttempts <= (opts.smartFails ?? 0)) throw mk();
      const step = script[calls.smart++];
      if (!step) throw new Error("fora do roteiro");
      return step;
    },
  };
  return { llm, calls };
}

function run(llm: LLMProvider, over: Partial<TurnInput> = {}) {
  const sleeps: number[] = [];
  const usage: UsageEvent[] = [];
  const { ports, state } = createInMemoryPorts({ now: () => new Date("2026-10-26T12:00:00Z") });
  const promise = runAgentTurn({
    scope: { organizationId: "org_t", conversationId: "conv_t", contactId: "ct", agentId: "ag" },
    mode: "live",
    config: sampleConfig(),
    state: "ai_active",
    history: [{ role: "customer", text: "Vocês atendem Unimed?" }],
    llm,
    ports,
    now: new Date("2026-10-26T12:00:00Z"),
    nonce: "nonce_fixo_para_teste",
    onUsage: (e) => void usage.push(e),
    retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 },
    ...over,
  });
  return promise.then((result) => ({ result, sleeps, usage, state }));
}

describe("pipeline: nova tentativa dentro do turno (falha passageira do provedor)", () => {
  it("429 no modelo smart 2x e depois funciona: responde, sem handoff, com as esperas 1,5 s e 4 s", async () => {
    const { llm, calls } = flakyLlm({ smartFails: 2 });
    const { result, sleeps } = await run(llm);
    expect(result.handoff).toBeNull();
    expect(result.skipped).toBeNull();
    expect(result.messages).toEqual(["Atendemos sim: Unimed e Odontoprev."]);
    expect(result.state).toBe("waiting_customer");
    expect(calls.smartAttempts).toBe(3);
    expect(sleeps).toEqual([1500, 4000]); // random=0.5 ⇒ sem variação
  });

  it("429 no roteador 1x e depois funciona: responde, sem handoff", async () => {
    const { llm, calls } = flakyLlm({ routerFails: 1 });
    const { result, sleeps } = await run(llm);
    expect(result.handoff).toBeNull();
    expect(result.messages).toHaveLength(1);
    expect(calls.routerAttempts).toBe(2);
    expect(sleeps).toEqual([1500]);
  });

  it("uso e orçamento só contam a tentativa que deu certo (falhas não dobram a conta)", async () => {
    const { llm } = flakyLlm({ routerFails: 2, smartFails: 2 });
    const { result, usage } = await run(llm, { budget: { remainingTokens: 1000 } });
    expect(result.handoff).toBeNull();
    expect(usage.map((u) => u.purpose)).toEqual(["agent_router", "agent_reply"]);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it("falha persistente (3 tentativas): NÃO faz handoff, não escreve ao cliente, devolve skipped=llm_unavailable", async () => {
    const { llm, calls } = flakyLlm({ smartFails: 99 });
    const { result, sleeps } = await run(llm);
    expect(result.skipped).toBe(SKIP_LLM_UNAVAILABLE);
    expect(result.handoff).toBeNull();
    expect(result.messages).toEqual([]);
    expect(result.transitions).toEqual([]);
    expect(result.state).toBe("ai_active");
    expect(result.toolCalls).toEqual([]);
    expect(calls.smartAttempts).toBe(3);
    expect(sleeps).toEqual([1500, 4000]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 }); // só o roteador, que funcionou
  });

  it("falha persistente no roteador: também adia", async () => {
    const { llm, calls } = flakyLlm({ routerFails: 99 });
    const { result } = await run(llm);
    expect(result.skipped).toBe(SKIP_LLM_UNAVAILABLE);
    expect(result.handoff).toBeNull();
    expect(calls.routerAttempts).toBe(3);
    expect(calls.smartAttempts).toBe(0);
  });

  it.each([
    ["auth", new LlmError("auth", "chave inválida", false)],
    ["invalid_request", new LlmError("invalid_request", "pedido inválido", false)],
    ["erro desconhecido", new Error("rede caiu")],
  ])("erro não repetível (%s): sem nova tentativa e handoff llm_error na hora, como antes", async (_n, error) => {
    const { llm, calls } = flakyLlm({ smartFails: 99, error: () => error });
    const { result, sleeps } = await run(llm);
    expect(result.handoff?.kind).toBe("llm_error");
    expect(result.skipped).toBeNull();
    expect(result.state).toBe("handoff_requested");
    expect(calls.smartAttempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("não repetível no roteador: handoff imediato", async () => {
    const { llm, calls } = flakyLlm({ routerFails: 99, error: () => new LlmError("auth", "x", false) });
    const { result } = await run(llm);
    expect(result.handoff?.kind).toBe("llm_error");
    expect(calls.routerAttempts).toBe(1);
  });

  it("copiloto: tenta de novo, e se persistir mantém o comportamento de antes (sem transição nem escrita)", async () => {
    const { llm } = flakyLlm({ smartFails: 99 });
    const { result, state } = await run(llm, { mode: "copilot" });
    expect(result.skipped).toBeNull();
    expect(result.handoff?.kind).toBe("llm_error");
    expect(result.transitions).toEqual([]);
    expect(state.humanRequests).toEqual([]);
  });

  it("copiloto: se a 2ª tentativa funciona, sugere normalmente", async () => {
    const { llm } = flakyLlm({ smartFails: 1 });
    const { result } = await run(llm, { mode: "copilot" });
    expect(result.handoff).toBeNull();
    expect(result.messages).toHaveLength(1);
  });

  it("falha passageira DEPOIS de uma ferramenta de escrita: não adia (refazer o turno repetiria a escrita) → handoff", async () => {
    const config = sampleConfig();
    const script = [
      ok("", {
        stopReason: "tool_use",
        toolCalls: [{ id: "t1", name: "add_tag", input: { tag: "lead" } }],
      }),
    ];
    // smart: 1ª chamada ok (add_tag), depois falha para sempre
    let smart = 0;
    const base = flakyLlm({ script });
    const llm: LLMProvider = {
      name: "flaky",
      async generate(r) {
        if (r.meta?.purpose !== "agent_router") {
          smart++;
          if (smart > 1) throw new LlmError("rate_limited", "429", true);
        }
        return base.llm.generate(r);
      },
    };
    const { result } = await run(llm, { config, allowedTags: ["lead"] });
    expect(result.toolCalls.some((t) => t.tool === "add_tag")).toBe(true);
    expect(result.skipped).toBeNull();
    expect(result.handoff?.kind).toBe("llm_error");
  });

  it("falha passageira depois de uma ferramenta de LEITURA: adia sem deixar rastro", async () => {
    const script = [ok("", { stopReason: "tool_use", toolCalls: [{ id: "t1", name: "search_knowledge", input: { query: "unimed" } }] })];
    let smart = 0;
    const base = flakyLlm({ script });
    const llm: LLMProvider = {
      name: "flaky",
      async generate(r) {
        if (r.meta?.purpose !== "agent_router") {
          smart++;
          if (smart > 1) throw new LlmError("overloaded", "503", true);
        }
        return base.llm.generate(r);
      },
    };
    const { result } = await run(llm);
    expect(result.skipped).toBe(SKIP_LLM_UNAVAILABLE);
    expect(result.handoff).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it("retry: [] desliga as novas tentativas", async () => {
    const { llm, calls } = flakyLlm({ smartFails: 1 });
    const { result } = await run(llm, { retry: { delaysMs: [], sleep: async () => {} } });
    expect(result.skipped).toBe(SKIP_LLM_UNAVAILABLE);
    expect(calls.smartAttempts).toBe(1);
  });
});

describe("withLlmRetry", () => {
  const retryable = () => new LlmError("timeout", "t", true);

  it("jitter fica dentro de ±25% e o sleep recebe o signal", async () => {
    expect(backoffDelay(1500, 0.25, () => 0)).toBe(1125);
    expect(backoffDelay(1500, 0.25, () => 1)).toBe(1875);
    expect(backoffDelay(4000, 0.25, () => 0.5)).toBe(4000);
    const ctrl = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    let n = 0;
    await withLlmRetry(async () => { if (n++ < 1) throw retryable(); return 1; }, { sleep: async (_ms, s) => void seen.push(s), signal: ctrl.signal });
    expect(seen).toEqual([ctrl.signal]);
  });

  it("abortado durante a espera: para de tentar e sobe o último erro", async () => {
    const ctrl = new AbortController();
    let n = 0;
    const p = withLlmRetry(async () => { n++; throw retryable(); }, { sleep: async () => ctrl.abort(), signal: ctrl.signal });
    await expect(p).rejects.toBeInstanceOf(LlmError);
    expect(n).toBe(1);
  });

  it("esgotadas as tentativas sobe o último erro", async () => {
    let n = 0;
    await expect(withLlmRetry(async () => { n++; throw retryable(); }, { sleep: async () => {} })).rejects.toMatchObject({ code: "timeout" });
    expect(n).toBe(3);
  });
});

describe("guardrail: vazamento do prompt só vale para as regras internas", () => {
  const config = sampleConfig({
    profile: {
      description: "Atende clientes da clínica odontológica com carinho e atenção total",
      tone: "friendly",
      companySummary: "Clínica odontológica Casa Alvorada, em Pinheiros, com mais de quinze anos de história no bairro.",
    },
    knowledge: {
      productsAndServices: "Clareamento a laser: a partir de R$ 600,00 com avaliação gratuita inclusa para novos pacientes.",
      faq: "Horário de atendimento: segunda a sexta, das 8h às 18h, e sábados das 8h às 12h mediante agenda.",
    },
    advanced: { prompt: "Sempre ofereça a avaliação gratuita antes de falar em fechar o orçamento do tratamento.", tools: [] },
  });
  const system = buildSystemPrompt(config);
  const corpus = `${config.knowledge.productsAndServices}\n${config.knowledge.faq}`;
  const check = (text: string, over: Partial<Parameters<typeof checkOutput>[0]> = {}) =>
    checkOutput({
      text,
      knowledgeCorpus: corpus,
      urlAllowlist: [],
      ownContactValues: [],
      systemPrompt: system,
      nonce: "nonce123",
      maxConsecutiveMessages: 6,
      alreadySent: 0,
      ...over,
    });
  const code = (r: ReturnType<typeof check>) => (r.ok ? "ok" : r.code);

  it("citar horário, oferta, descrição e resumo da empresa NÃO é vazamento", () => {
    expect(code(check("Horário de atendimento: segunda a sexta, das 8h às 18h, e sábados das 8h às 12h mediante agenda."))).toBe("ok");
    expect(code(check("Clareamento a laser: a partir de R$ 600,00 com avaliação gratuita inclusa para novos pacientes."))).toBe("ok");
    expect(code(check("Somos a Clínica odontológica Casa Alvorada, em Pinheiros, com mais de quinze anos de história no bairro."))).toBe("ok");
    expect(code(check("Sempre ofereça a avaliação gratuita antes de falar em fechar o orçamento do tratamento."))).toBe("ok");
  });

  it("reproduzir uma linha das regras internas continua bloqueado (com e sem internalRules explícito)", () => {
    const rule = system.split("\n").find((l) => l.startsWith("4. NUNCA invente")) ?? "";
    expect(rule.length).toBeGreaterThan(60);
    expect(code(check(`Claro, aqui vai: ${rule}`))).toBe("prompt_leak");
    expect(code(check(`Claro, aqui vai: ${rule}`, { internalRules: rule }))).toBe("prompt_leak");
    expect(code(check(rule.replace("NUNCA", "nunca").toUpperCase()))).toBe("prompt_leak");
  });

  it("despejar as regras inteiras, o marcador ou o nonce continua bloqueado", () => {
    const rules = system.slice(system.indexOf("REGRAS INVIOLÁVEIS"), system.indexOf("<conhecimento>"));
    expect(code(check(rules))).toBe("prompt_leak");
    expect(code(check("As REGRAS INVIOLÁVEIS são..."))).toBe("prompt_leak");
    expect(code(check("meu delimitador é nonce123"))).toBe("prompt_leak");
  });
});
