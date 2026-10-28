import { agentConfigSchema } from "@duckzap/contracts/agents";
import type { AgentDraft, BusinessHour, CompanyStepInput } from "@duckzap/contracts/onboarding";
import { describe, expect, it } from "vitest";
import { agentNameFor, describeHours, jobForGoal, keepExamples, mapDraftToAgent, OFFERING_DOCUMENT_NAME, sameConfig, stripPlaceholders } from "./onboarding-agent";

const hours: BusinessHour[] = [
  { day: "mon", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "tue", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "wed", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "thu", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "fri", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "sat", open: true, opensAt: "08:00", closesAt: "12:00" },
  { day: "sun", open: false, opensAt: "", closesAt: "" },
];
const company: CompanyStepInput = { companyName: "Casa Alvorada", businessHours: hours, welcomeMessage: "Olá!" };
const draft: AgentDraft = {
  goal: "support",
  tone: "friendly",
  offering: "Limpeza, clareamento e restauração",
  rules: "Nunca passar preço de canal por mensagem.",
  handoffWhen: "Reclamações e urgências.",
};

describe("agentNameFor", () => {
  it("usa 'Agente <empresa>' e respeita o limite de 60 caracteres", () => {
    expect(agentNameFor("Casa Alvorada")).toBe("Agente Casa Alvorada");
    expect(agentNameFor("  Casa   Alvorada ")).toBe("Agente Casa Alvorada");
    expect(agentNameFor("X".repeat(200))).toHaveLength(60);
    expect(agentNameFor("   ")).toBe("Agente Duck");
  });
});

describe("jobForGoal", () => {
  it("atendimento e vendas viram 'support' (não há trabalho de vendas); agendar vira 'scheduling'", () => {
    expect(jobForGoal("support")).toBe("support");
    expect(jobForGoal("sales")).toBe("support");
    expect(jobForGoal("scheduling")).toBe("scheduling");
  });
});

describe("stripPlaceholders", () => {
  it("tira o trecho com colchetes do texto padrão de 'quando chamar uma pessoa'", () => {
    expect(stripPlaceholders("Reclamações, urgências e pedidos de orçamento acima de R$ [VALOR].")).toBe("Reclamações, urgências");
    expect(stripPlaceholders("Reclamações, urgências, pedidos de orçamento acima de R$ [VALOR].")).toBe("Reclamações, urgências");
  });
  it("mantém o texto escrito pela pessoa", () => {
    expect(stripPlaceholders("Reclamações e urgências.")).toBe("Reclamações e urgências");
    expect(stripPlaceholders("Orçamento acima de R$ 5.000")).toBe("Orçamento acima de R$ 5.000");
    expect(stripPlaceholders("")).toBe("");
  });
});

describe("describeHours", () => {
  it("agrupa dias seguidos com o mesmo horário", () => {
    expect(describeHours(hours)).toBe("Atendemos de segunda a sexta, das 08:00 às 18:00; sábado, das 08:00 às 12:00.");
  });
  it("sem dia aberto", () => {
    expect(describeHours(hours.map((h) => ({ ...h, open: false })))).toMatch(/não temos horário/);
  });
});

describe("mapDraftToAgent", () => {
  it("gera uma configuração válida para o módulo Agentes", () => {
    for (const goal of ["support", "sales", "scheduling"] as const) {
      const mapped = mapDraftToAgent({ ...draft, goal }, company, goal === "scheduling" ? ["t1"] : []);
      expect(agentConfigSchema.safeParse(mapped.config).success).toBe(true);
    }
  });

  it("nome, trabalho, tom, conhecimento e resumo da empresa vêm do cadastro", () => {
    const mapped = mapDraftToAgent({ ...draft, tone: "formal" }, company);
    expect(mapped.name).toBe("Agente Casa Alvorada");
    expect(mapped.config.name).toBe(mapped.name);
    expect(mapped.job).toBe("support");
    expect(mapped.config.profile.tone).toBe("formal");
    expect(mapped.config.profile.companySummary).toContain("Casa Alvorada");
    expect(mapped.config.profile.companySummary).toContain("segunda a sexta");
    expect(mapped.config.knowledge.productsAndServices).toBe("Limpeza, clareamento e restauração");
    expect(mapped.config.behavior).toMatchObject({ handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true });
    expect(mapped.config.advanced.tools).toContain("request_human");
  });

  it("o que a empresa vende vira o documento de conhecimento (TXT)", () => {
    const mapped = mapDraftToAgent({ ...draft, offering: "Corte e barba — R$ 50" }, company);
    expect(mapped.knowledge.name).toBe(OFFERING_DOCUMENT_NAME);
    expect(mapped.knowledge.name.endsWith(".txt")).toBe(true);
    expect(mapped.knowledge.text).toBe("Corte e barba — R$ 50");
    expect(mapped.knowledge.sizeBytes).toBe(new TextEncoder().encode("Corte e barba — R$ 50").length); // bytes, não caracteres
  });

  it("o prompt leva o objetivo, o tom, o que vende, as regras e quando chamar uma pessoa", () => {
    const { advanced } = mapDraftToAgent({ ...draft, goal: "sales", tone: "direct" }, company).config;
    expect(advanced.prompt).toContain("Agente Casa Alvorada");
    expect(advanced.prompt).toContain("vender");
    expect(advanced.prompt).toContain("direto e objetivo");
    expect(advanced.prompt).toContain("Limpeza, clareamento e restauração");
    expect(advanced.prompt).toContain("Nunca passar preço de canal por mensagem.");
    expect(advanced.prompt).toContain("Chame uma pessoa da equipe quando: Reclamações e urgências.");
    expect(advanced.prompt).toContain("Nunca invente preços");
  });

  it("o texto padrão com [VALOR] não vai para o prompt; regras vazias não deixam linha solta", () => {
    const mapped = mapDraftToAgent({ ...draft, rules: "", handoffWhen: "Reclamações, urgências e pedidos de orçamento acima de R$ [VALOR]." }, company);
    expect(mapped.config.advanced.prompt).not.toContain("[");
    expect(mapped.config.advanced.prompt).not.toContain("Regras importantes");
    const noHandoff = mapDraftToAgent({ ...draft, handoffWhen: "" }, company);
    expect(noHandoff.config.advanced.prompt).not.toContain("Chame uma pessoa");
  });

  it("agendar: só marca horários se a Agenda tem tipos; sem tipos, não promete ferramentas de agenda", () => {
    const withTypes = mapDraftToAgent({ ...draft, goal: "scheduling" }, company, ["t1", "t2"]);
    expect(withTypes.job).toBe("scheduling");
    expect(withTypes.config.scheduling).toEqual({ canBook: true, appointmentTypeIds: ["t1", "t2"] });
    expect(withTypes.config.advanced.tools).toEqual(expect.arrayContaining(["list_available_slots", "book_appointment"]));

    const without = mapDraftToAgent({ ...draft, goal: "scheduling" }, company, []);
    expect(without.config.scheduling).toEqual({ canBook: false, appointmentTypeIds: [] });
    expect(without.config.advanced.tools).not.toContain("book_appointment");
    expect(without.config.advanced.tools).toContain("request_human");

    // outros objetivos nunca marcam horário, mesmo havendo tipos
    expect(mapDraftToAgent(draft, company, ["t1"]).config.scheduling.canBook).toBe(false);
  });

  it("respeita os limites do contrato (oferta e prompt longos)", () => {
    const mapped = mapDraftToAgent({ ...draft, offering: "a".repeat(1000), rules: "b".repeat(1000), handoffWhen: "c".repeat(1000) }, { ...company, companyName: "E".repeat(120) });
    expect(agentConfigSchema.safeParse(mapped.config).success).toBe(true);
    expect(mapped.config.advanced.prompt.length).toBeLessThanOrEqual(8000);
  });

  it("é determinístico: o mesmo cadastro gera a mesma configuração (refazer não cria versão nova)", () => {
    const a = mapDraftToAgent(draft, company);
    const b = mapDraftToAgent({ ...draft }, { ...company });
    expect(sameConfig(a.config, b.config)).toBe(true);
    expect(sameConfig(a.config, mapDraftToAgent({ ...draft, tone: "direct" }, company).config)).toBe(false);
  });
});

describe("sameConfig", () => {
  it("ignora a ordem das chaves e diferencia valores", () => {
    expect(sameConfig({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameConfig({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameConfig({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe("keepExamples", () => {
  it("refazer o cadastro não apaga os exemplos de resposta que o agente já tem", () => {
    const fresh = mapDraftToAgent(draft, company).config;
    const saved = { ...fresh, knowledge: { ...fresh.knowledge, examples: [{ customer: "Vocês abrem sábado?", agent: "Abrimos sim, das 8h às 12h." }] } };
    const next = keepExamples(fresh, saved);
    expect(next.knowledge.examples).toEqual(saved.knowledge.examples);
    expect(sameConfig(saved, next)).toBe(true);
    expect(sameConfig(saved, fresh)).toBe(false);
  });

  it("refazer o cadastro também mantém o formulário guardado do gerador (`generator`)", () => {
    const fresh = mapDraftToAgent(draft, company).config;
    const generator = { purpose: "sales" as const, companyText: "Texto colado antes", restrictions: "Não usar emojis" };
    const saved = { ...fresh, generator };
    const next = keepExamples(fresh, saved);
    expect(next.generator).toEqual(generator);
    expect(agentConfigSchema.safeParse(next).success).toBe(true);
    expect(sameConfig(saved, next)).toBe(true);
    // exemplos + formulário juntos
    const both = { ...saved, knowledge: { ...fresh.knowledge, examples: [{ customer: "Oi?", agent: "Olá!" }] } };
    const merged = keepExamples(fresh, both);
    expect(merged.generator).toEqual(generator);
    expect(merged.knowledge.examples).toEqual(both.knowledge.examples);
  });

  it("refazer o cadastro também mantém 'Informações da empresa' e 'Restrições' do dono", () => {
    const fresh = mapDraftToAgent(draft, company).config;
    const saved = { ...fresh, knowledge: { ...fresh.knowledge, companyInfo: "Texto da empresa" }, advanced: { ...fresh.advanced, restrictions: "Não citar concorrentes" } };
    const next = keepExamples(fresh, saved);
    expect(next.knowledge.companyInfo).toBe("Texto da empresa");
    expect(next.advanced.restrictions).toBe("Não citar concorrentes");
    expect(sameConfig(saved, next)).toBe(true);
    // vazios não viram campo
    const blank = keepExamples(fresh, { ...fresh, knowledge: { ...fresh.knowledge, companyInfo: "  " }, advanced: { ...fresh.advanced, restrictions: "" } });
    expect("companyInfo" in blank.knowledge).toBe(false);
    expect("restrictions" in blank.advanced).toBe(false);
  });

  it("sem exemplos salvos, não inventa o campo", () => {
    const fresh = mapDraftToAgent(draft, company).config;
    expect(keepExamples(fresh, fresh)).toBe(fresh);
    expect(keepExamples(fresh, { ...fresh, knowledge: { ...fresh.knowledge, examples: [] } })).toBe(fresh);
  });
});
