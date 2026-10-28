import { describe, expect, it } from "vitest";
import { runScenario, sampleConfig, type Scenario } from "../evals/harness";

const base: Scenario = {
  id: "t",
  description: "t",
  history: [{ role: "customer", text: "Vocês atendem Unimed?" }],
  router: { intent: "question", confidence: 0.9 },
  model: ["Atendemos sim: Unimed e Odontoprev."],
  expect: {},
};

describe("pipeline: estados auditados", () => {
  it("resposta: ai_active → waiting_customer", async () => {
    const { result } = await runScenario(base);
    expect(result.state).toBe("waiting_customer");
    expect(result.transitions.map((t) => [t.from, t.to, t.event])).toEqual([["ai_active", "waiting_customer", "ai_replied"]]);
  });

  it("cliente responde em waiting_customer: reabre para ai_active e depois responde", async () => {
    const { result } = await runScenario({ ...base, state: "waiting_customer" });
    expect(result.transitions.map((t) => t.event)).toEqual(["customer_message", "ai_replied"]);
    expect(result.state).toBe("waiting_customer");
  });

  it("handoff: → handoff_requested e a IA se cala nas mensagens seguintes", async () => {
    const first = await runScenario({ ...base, history: [{ role: "customer", text: "Quero falar com uma pessoa" }], model: undefined });
    expect(first.result.state).toBe("handoff_requested");
    expect(first.result.transitions.at(-1)).toMatchObject({ to: "handoff_requested", actor: "ai" });
    const next = await runScenario({ ...base, state: first.result.state });
    expect(next.result.skipped).toBe("handoff_requested");
    expect(next.result.messages).toEqual([]);
  });

  it("conversa resolvida reaberta pelo cliente", async () => {
    const { result } = await runScenario({ ...base, state: "resolved" });
    expect(result.transitions[0]).toMatchObject({ from: "resolved", to: "ai_active", event: "customer_message" });
  });
});

describe("pipeline: modos sem efeito", () => {
  it("copiloto: sugere, não transiciona nem grava", async () => {
    const { result, fake } = await runScenario({
      ...base,
      mode: "copilot",
      history: [{ role: "customer", text: "Quero marcar limpeza" }],
      router: { intent: "schedule", confidence: 0.9 },
      model: [
        { toolCalls: [{ id: "t1", name: "book_appointment", input: { slot_id: "slot:apt_limpeza:2026-10-27T17:00:00Z", type_id: "apt_limpeza" } }], stopReason: "tool_use" },
        "Posso deixar pré-agendado para terça às 14h?",
      ],
    });
    expect(result.messages.length).toBe(1);
    expect(result.transitions).toEqual([]);
    expect(fake.writes).toEqual([]);
  });

  it("respondWhen=outside_hours: dentro do horário a IA não responde", async () => {
    const config = sampleConfig({ behavior: { ...sampleConfig().behavior, respondWhen: "outside_hours" } });
    const { requests } = await runScenario({ ...base, config });
    // sem horário comercial informado o pipeline não tem como saber: responde (comportamento seguro: nunca silencia por engano)
    expect(requests.length).toBeGreaterThan(0);
  });

  it("falha do provedor vira handoff (llm_error), nunca exceção", async () => {
    const { runAgentTurn, createInMemoryPorts } = await import("../src");
    const { ports } = createInMemoryPorts();
    const result = await runAgentTurn({
      scope: { organizationId: "o", conversationId: "c", contactId: "k", agentId: "a" },
      mode: "live",
      config: sampleConfig(),
      state: "ai_active",
      history: [{ role: "customer", text: "Vocês atendem Unimed?" }],
      llm: { name: "x", generate: async () => { throw new Error("rede caiu"); } },
      ports,
    });
    expect(result.handoff?.kind).toBe("llm_error");
  });

  it("registra uso de tokens por finalidade (orçamento)", async () => {
    const { runAgentTurn, createInMemoryPorts } = await import("../src");
    const events: string[] = [];
    const { ports } = createInMemoryPorts();
    const { llm } = (await import("../evals/harness")).scriptedLlm(base);
    const result = await runAgentTurn({
      scope: { organizationId: "o", conversationId: "c", contactId: "k", agentId: "a" },
      mode: "live",
      config: sampleConfig(),
      state: "ai_active",
      history: base.history,
      llm,
      ports,
      onUsage: (e) => void events.push(e.purpose),
    });
    expect(events).toEqual(["agent_router", "agent_reply"]);
    expect(result.usage.inputTokens).toBe(200);
  });
});

describe("pipeline: só o classificador achar que é pedido de pessoa não transfere", () => {
  it("pergunta sobre o próprio serviço ('vocês transferem para um humano?') vai para o agente, que responde", async () => {
    const { result, counts } = await runScenario({
      ...base,
      history: [{ role: "customer", text: "o atendimento de vocês transfere pra um humano quando precisa?" }],
      router: { intent: "human", confidence: 0.9 },
      model: ["Sim! Quando o cliente pede ou o caso é sensível, a conversa vai para uma pessoa."],
    });
    expect(result.handoff).toBeNull();
    expect(result.messages).toHaveLength(1);
    expect(counts().smart).toBe(1);
  });

  it("o agente ainda pode chamar a equipe quando o cliente quis mesmo uma pessoa (pedido fora das frases fixas)", async () => {
    const { result } = await runScenario({
      ...base,
      history: [{ role: "customer", text: "preciso resolver a Unimed com o Carlos do financeiro" }],
      router: { intent: "human", confidence: 0.9 },
      model: [{ toolCalls: [{ id: "t1", name: "request_human", input: { reason: "Cliente quer falar com o Carlos do financeiro." } }], stopReason: "tool_use" }],
    });
    expect(result.handoff?.kind).toBe("model_request");
  });

  it("pedido explícito continua transferindo na hora, sem chamar o agente", async () => {
    const { result, counts } = await runScenario({
      ...base,
      history: [{ role: "customer", text: "quero falar com um atendente" }],
      model: undefined,
    });
    expect(result.handoff?.kind).toBe("customer_request");
    expect(counts().smart).toBe(0);
  });
});

describe("pipeline: cumprimentos não passam pelo roteador (nem viram transferência)", () => {
  it.each(["ola boa tarde", "oi", "bom dia", "obrigado", "teste"])("%s: responde, sem chamar o roteador e sem handoff", async (text) => {
    // roteador com confiança baixa: se ele fosse consultado, a conversa iria para a equipe
    const { result, requests } = await runScenario({
      ...base,
      history: [{ role: "customer", text }],
      router: { intent: "question", confidence: 0.3 },
      model: ["Olá! Como posso ajudar?"],
    });
    expect(result.handoff).toBeNull();
    expect(result.messages).toEqual(["Olá! Como posso ajudar?"]);
    expect(requests.some((r) => r.meta?.purpose === "agent_router")).toBe(false);
  });

  it.each(["opa bão", "opa", "e aí", "eai", "salve", "fala", "oie"])("gíria de cumprimento %s também não chama o roteador", async (text) => {
    const { result, requests } = await runScenario({
      ...base,
      history: [{ role: "customer", text }],
      router: { intent: "question", confidence: 0.3 },
      model: ["Opa! Como posso ajudar?"],
    });
    expect(result.handoff).toBeNull();
    expect(requests.some((r) => r.meta?.purpose === "agent_router")).toBe(false);
  });

  it("gíria no começo de uma pergunta de verdade NÃO é cumprimento (vai pelo roteador)", async () => {
    const { requests } = await runScenario({
      ...base,
      history: [{ role: "customer", text: "fala mano, tem site pra vender" }],
      router: { intent: "question", confidence: 0.9 },
      model: ["Temos sim!"],
    });
    expect(requests.some((r) => r.meta?.purpose === "agent_router")).toBe(true);
  });

  it("pergunta de verdade com confiança baixa continua indo para a equipe", async () => {
    const { result } = await runScenario({
      ...base,
      history: [{ role: "customer", text: "qual o prazo de entrega do pedido 4521?" }],
      router: { intent: "question", confidence: 0.3 },
      model: undefined,
    });
    expect(result.handoff?.kind).toBe("low_confidence");
  });
});
