import { createFakeLlm, createInMemoryPorts, type AppointmentTypeInfo } from "@duckzap/ai";
import { agentConfigSchema, type AgentConfig } from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import { chunkText, documentKind } from "./chunking";
import { loadAgentsConfig } from "./config";
import { buildTsQuery } from "./knowledge-store";
import { checkCanActivate, checkCanCreateAgent, checkCopilotAllowed, effectiveStatus } from "./plan";
import { describeChange } from "./service";
import { pickSimulatorLlm, simulateReply } from "./simulate";

const config: AgentConfig = agentConfigSchema.parse({
  name: "Duck",
  profile: { description: "Atende clientes", tone: "friendly", companySummary: "Clínica Casa Alvorada." },
  knowledge: {
    productsAndServices: "Limpeza dental: 45 minutos.\nClareamento a laser a partir de R$ 600,00.",
    faq: "Atendemos Unimed e Odontoprev.",
  },
  behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
  followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
  scheduling: { canBook: true, appointmentTypeIds: ["apt_limpeza"] },
  advanced: { prompt: "Nunca invente preços.", tools: ["search_knowledge", "list_available_slots", "book_appointment", "request_human"] },
});

const types: AppointmentTypeInfo[] = [{ id: "apt_limpeza", name: "Limpeza", durationMinutes: 45, staffOnly: false }];
const { ports } = createInMemoryPorts();

async function sim(history: { role: "customer" | "agent"; text: string }[], over: Partial<Parameters<typeof simulateReply>[0]> = {}) {
  return simulateReply({
    llm: createFakeLlm(),
    organizationId: "org_x",
    agentId: "agt_x",
    config,
    history,
    knowledge: ports.knowledge,
    types,
    now: new Date("2026-10-26T12:00:00Z"),
    ...over,
  });
}

describe("regras de plano (§1.2)", () => {
  const basico = { maxAgents: 1, features: [] as string[] };
  const pro = { maxAgents: null, features: ["campaigns", "instagram"] };
  const empresarial = { maxAgents: null, features: ["campaigns", "instagram", "copilot", "byo_ai"] };

  it("Básico: no máximo 1 agente", () => {
    expect(checkCanCreateAgent(basico, 0, "support").ok).toBe(true);
    expect(checkCanCreateAgent(basico, 1, "support")).toMatchObject({ ok: false, code: "plan_limit" });
  });
  it("Pro/Empresarial: agentes ilimitados", () => {
    expect(checkCanCreateAgent(pro, 50, "scheduling").ok).toBe(true);
    expect(checkCanCreateAgent(empresarial, 50, "support").ok).toBe(true);
  });
  it("Instagram só do Pro em diante (criar e ativar); a feature vem antes do limite", () => {
    expect(checkCanCreateAgent(basico, 0, "instagram_dm")).toMatchObject({ ok: false, code: "plan_feature" });
    expect(checkCanCreateAgent(basico, 5, "comments")).toMatchObject({ ok: false, code: "plan_feature" });
    expect(checkCanCreateAgent(pro, 0, "instagram_dm").ok).toBe(true);
    expect(checkCanCreateAgent(empresarial, 0, "instagram_dm").ok).toBe(true);
    expect(checkCanActivate(basico, "comments")).toMatchObject({ ok: false, code: "plan_feature" });
    expect(checkCanActivate(pro, "comments").ok).toBe(true);
    expect(checkCanActivate(basico, "support").ok).toBe(true);
  });
  it("Copiloto só no Empresarial", () => {
    expect(checkCopilotAllowed(basico)).toMatchObject({ ok: false, code: "plan_feature" });
    expect(checkCopilotAllowed(pro)).toMatchObject({ ok: false, code: "plan_feature" });
    expect(checkCopilotAllowed(empresarial).ok).toBe(true);
  });
  it("agente de Instagram ativo que perdeu o recurso (caiu para o Básico) aparece pausado pelo sistema", () => {
    expect(effectiveStatus({ status: "active", pausedReason: null }, "instagram_dm", basico)).toEqual({ status: "paused", pausedReason: "plan_feature" });
    expect(effectiveStatus({ status: "active", pausedReason: null }, "instagram_dm", pro)).toEqual({ status: "active", pausedReason: null });
    expect(effectiveStatus({ status: "paused", pausedReason: "manual" }, "support", basico)).toEqual({ status: "paused", pausedReason: "manual" });
  });
});

describe("conhecimento", () => {
  it("divide em trechos respeitando parágrafos e tamanho", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Parágrafo ${i}. ${"palavra ".repeat(30)}`).join("\n\n");
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 520)).toBe(true);
    expect(chunks.join(" ")).toContain("Parágrafo 11");
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("x".repeat(2500), 900).every((c) => c.length <= 900)).toBe(true);
  });
  it("consulta full-text só com [a-z0-9] (nada vira operador)", () => {
    expect(buildTsQuery("Quanto custa a limpeza & (drop table)?")).toBe("limpeza:* | drop:* | table:*");
    expect(buildTsQuery("!!! ???")).toBe("");
  });
  it("tipo de arquivo", () => {
    expect(documentKind("Tabela.PDF")).toBe("pdf");
    expect(documentKind("x.exe")).toBeNull();
  });
});

describe("configuração do módulo", () => {
  it("padrões e allowlist", () => {
    expect(loadAgentsConfig({}).AGENTS_SIMULATOR_PER_MINUTE).toBe(20);
    expect(loadAgentsConfig({ AGENTS_URL_ALLOWLIST: "a.com, b.com.br" }).AGENTS_URL_ALLOWLIST).toEqual(["a.com", "b.com.br"]);
  });
});

describe("simulador (sem chave: LLM de demonstração; nunca grava)", () => {
  it("sem provedor configurado usa o LLM de demonstração", () => {
    expect(pickSimulatorLlm(createFakeLlm()).name).toBe("fake");
    expect(
      pickSimulatorLlm({
        name: "anthropic",
        generate: async () => {
          throw new Error("x");
        },
      }).name,
    ).toBe("anthropic");
  });

  it("responde dúvida a partir do conhecimento", async () => {
    const r = await sim([{ role: "customer", text: "Vocês atendem Unimed?" }]);
    expect(r.handoff).toBeNull();
    expect(r.messages.join(" ")).toContain("Unimed");
    expect(r.intent).toBe("question");
  });

  it("pedido de pessoa → handoff com request_human em modo teste", async () => {
    const r = await sim([{ role: "customer", text: "Quero falar com um atendente" }]);
    expect(r.handoff).not.toBeNull();
    expect(r.intent).toBe("human");
    expect(r.toolCalls.at(-1)).toMatchObject({ tool: "request_human", result: expect.stringContaining("teste") });
  });

  it("preço fora do conhecimento → handoff, sem inventar valor", async () => {
    const r = await sim([{ role: "customer", text: "Quanto custa um implante?" }]);
    expect(r.handoff).not.toBeNull();
    expect(r.messages.join(" ")).not.toMatch(/R\$/);
  });

  it("agendamento: lista horários e depois cria PENDENTE em dry-run", async () => {
    const first = await sim([{ role: "customer", text: "Quero marcar uma limpeza" }]);
    expect(first.toolCalls.map((t) => t.tool)).toContain("list_available_slots");
    expect(first.messages.join(" ")).toMatch(/08h30/);
    const second = await sim([
      { role: "customer", text: "Quero marcar uma limpeza" },
      { role: "agent", text: first.messages.join(" ") },
      { role: "customer", text: "14h" },
    ]);
    const book = second.toolCalls.find((t) => t.tool === "book_appointment");
    expect(book?.result).toContain("(teste)");
    expect(second.handoff).toBeNull();
  });

  it("agenda é função do sistema: agente legado (canBook=false, sem ferramentas de agenda) agenda se a empresa tem tipo; sem tipo, não", async () => {
    const legacy: AgentConfig = { ...config, scheduling: { canBook: false, appointmentTypeIds: [] }, advanced: { ...config.advanced, tools: ["search_knowledge", "request_human"] } };
    const withTypes = await sim([{ role: "customer", text: "Quero marcar uma limpeza" }], { config: legacy });
    expect(withTypes.toolCalls.map((t) => t.tool)).toContain("list_available_slots");
    const noTypes = await sim([{ role: "customer", text: "Quero marcar uma limpeza" }], { config: { ...config, scheduling: { canBook: true, appointmentTypeIds: ["apt_limpeza"] } }, types: [] });
    expect(noTypes.toolCalls.map((t) => t.tool)).not.toContain("list_available_slots");
    // tipo "só a equipe marca" não conta como agenda para a IA
    const onlyStaff = await sim([{ role: "customer", text: "Quero marcar uma limpeza" }], { config: legacy, types: [{ id: "apt_canal", name: "Canal", durationMinutes: 90, staffOnly: true }] });
    expect(onlyStaff.toolCalls.map((t) => t.tool)).not.toContain("list_available_slots");
  });

  it("opt-out", async () => {
    const r = await sim([{ role: "customer", text: "SAIR" }]);
    expect(r.intent).toBe("opt_out");
    expect(r.toolCalls).toEqual([]);
  });

  it("orçamento esgotado: handoff e nenhuma chamada de modelo", async () => {
    let calls = 0;
    const r = await sim([{ role: "customer", text: "Vocês atendem Unimed?" }], {
      remainingTokens: 0,
      llm: {
        name: "anthropic",
        generate: async () => {
          calls++;
          throw new Error("não deveria chamar");
        },
      },
    });
    expect(calls).toBe(0);
    expect(r.handoff?.reason).toMatch(/Orçamento/);
  });

  it("falha do provedor vira handoff, não erro 500", async () => {
    const r = await sim([{ role: "customer", text: "Vocês atendem Unimed?" }], {
      llm: {
        name: "anthropic",
        generate: async () => {
          throw new Error("rede");
        },
      },
    });
    expect(r.handoff).not.toBeNull();
  });
});

describe("resumo da versão (describeChange)", () => {
  it("menciona informações da empresa e restrições, cada uma no seu nome", () => {
    expect(describeChange(config, { ...config, knowledge: { ...config.knowledge, companyInfo: "## Sobre a empresa\nClínica." } })).toBe("Alterou informações da empresa");
    expect(describeChange(config, { ...config, advanced: { ...config.advanced, restrictions: "- Nunca falar de preços." } })).toBe("Alterou restrições");
    const both = { ...config, knowledge: { ...config.knowledge, companyInfo: "x" }, advanced: { ...config.advanced, restrictions: "y", prompt: "novo" } };
    expect(describeChange(config, both)).toBe("Alterou informações da empresa, prompt e ferramentas, restrições");
  });

  it("campo opcional ausente e vazio contam como igual; os outros resumos seguem iguais", () => {
    expect(describeChange(config, { ...config, knowledge: { ...config.knowledge, companyInfo: "" }, advanced: { ...config.advanced, restrictions: " " } })).toBe("Salvo sem alterações");
    expect(describeChange(config, { ...config, knowledge: { ...config.knowledge, faq: "Nova." } })).toBe("Alterou conhecimento");
  });
});

