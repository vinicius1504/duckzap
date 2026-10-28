import { agentConfigSchema, agentGeneratorOutputSchema, type AgentConfig } from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import {
  GENERATED_NOTICE,
  GENERATOR_SECTIONS,
  SECTION_LABELS,
  applyGeneratedProfile,
  describeCurrentSection,
  replaceAll,
  sectionsToReplace,
  sectionsWithContent,
  toGeneratedProfile,
  type GeneratedProfile,
} from "./agent-generator-apply";

// Fixture anonimizada, no formato da saída do gerador (contrato novo: companyInfo e restrictions; produtos e FAQ vazios).
const output = agentGeneratorOutputSchema.parse({
  description: "Recebe os clientes da Empresa Exemplo e direciona para o setor certo.",
  instructions: "Papel e objetivo\nVocê é a Duda, assistente da Empresa Exemplo no WhatsApp.",
  companySummary: "A Empresa Exemplo faz sites e sistemas.",
  companyInfo: "Sobre a empresa\nFaz sites e sistemas.\n\nProdutos e serviços\n1. Sites\n2. Sistemas\n\nPerguntas frequentes\nO que vocês fazem? Sites e sistemas.",
  restrictions: "Não informe preços.\nNão cite concorrentes.",
  productsAndServices: "",
  faq: "",
  examples: Array.from({ length: 9 }, (_, i) => ({ customer: `Pergunta ${i + 1}`, agent: `Resposta ${i + 1}` })),
  warnings: ["Formas de pagamento não informadas."],
});
const profile = toGeneratedProfile(output);

const empty: AgentConfig = {
  name: "Agente",
  profile: { description: "", tone: "direct", companySummary: "" },
  knowledge: { productsAndServices: "", faq: "" },
  behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
  followUp: { enabled: true, steps: [{ id: "s1", delayMinutes: 120, mode: "ai", content: "" }], respectBusinessHours: true, stopOnReply: true },
  scheduling: { canBook: true, appointmentTypeIds: ["t1"] },
  advanced: { prompt: "", tools: ["search_knowledge", "request_human"] },
};
const filled: AgentConfig = {
  ...empty,
  name: "Antigo",
  profile: { description: "Descrição antiga", tone: "formal", companySummary: "Resumo antigo" },
  knowledge: { companyInfo: "Texto antigo da empresa", productsAndServices: "Produto antigo", faq: "FAQ antigo", examples: [{ customer: "Oi?", agent: "Olá!" }] },
  advanced: { prompt: "Prompt antigo", restrictions: "Restrição antiga", tools: ["search_knowledge"] },
};

describe("toGeneratedProfile", () => {
  it("usa companyInfo e restrictions do gerador", () => {
    expect(profile.companyInfo).toBe(output.companyInfo);
    expect(profile.restrictions).toBe("Não informe preços.\nNão cite concorrentes.");
    expect(profile.companySummary).toBe("A Empresa Exemplo faz sites e sistemas.");
    expect(profile.examples).toHaveLength(9);
  });

  it("gerador que ainda devolve produtos e FAQ separados (companyInfo vazio): junta num texto só, sem perder nada", () => {
    const old = agentGeneratorOutputSchema.parse({ ...output, companyInfo: "", productsAndServices: "1. Sites", faq: "P: Oi? R: Olá!" });
    expect(old.companyInfo).toBe("");
    const merged = toGeneratedProfile(old);
    expect(merged.companyInfo).toBe("Sobre a empresa\nA Empresa Exemplo faz sites e sistemas.\n\nProdutos e serviços\n1. Sites\n\nPerguntas frequentes\nP: Oi? R: Olá!");
  });
});

describe("sectionsWithContent", () => {
  it("agente vazio não tem o que sobrescrever", () => {
    expect(sectionsWithContent(empty)).toEqual([]);
  });

  it("as seções são: informações da empresa, objetivos e instruções, restrições e exemplos", () => {
    expect(GENERATOR_SECTIONS).toEqual(["company", "goals", "restrictions", "examples"]);
    expect(SECTION_LABELS.company.title).toBe("Informações da empresa");
    expect(SECTION_LABELS.goals.title).toBe("Objetivos e instruções");
    expect(SECTION_LABELS.restrictions.title).toBe("Restrições");
    expect(SECTION_LABELS.examples.title).toBe("Exemplos de resposta");
    expect(sectionsWithContent(filled)).toEqual(["company", "goals", "restrictions", "examples"]);
  });

  it("lista só as seções com conteúdo; os campos antigos contam como informações da empresa", () => {
    expect(sectionsWithContent({ ...empty, advanced: { ...empty.advanced, prompt: "x" } })).toEqual(["goals"]);
    expect(sectionsWithContent({ ...empty, profile: { ...empty.profile, description: "x" } })).toEqual(["goals"]);
    expect(sectionsWithContent({ ...empty, advanced: { ...empty.advanced, restrictions: "x" } })).toEqual(["restrictions"]);
    expect(sectionsWithContent({ ...empty, knowledge: { ...empty.knowledge, faq: "x" } })).toEqual(["company"]);
    expect(sectionsWithContent({ ...empty, knowledge: { ...empty.knowledge, companyInfo: "x" } })).toEqual(["company"]);
    expect(sectionsWithContent({ ...empty, knowledge: { ...empty.knowledge, examples: [{ customer: "a", agent: "b" }] } })).toEqual(["examples"]);
    expect(sectionsWithContent({ ...empty, advanced: { ...empty.advanced, restrictions: "   " } })).toEqual([]);
  });

  it("descreve o conteúdo atual para a confirmação", () => {
    expect(describeCurrentSection(filled, "examples")).toBe("1 exemplo");
    expect(describeCurrentSection(filled, "goals")).toBe(`${"Descrição antiga".length + "Prompt antigo".length} caracteres`);
    expect(describeCurrentSection(filled, "restrictions")).toBe(`${"Restrição antiga".length} caracteres`);
  });
});

describe("applyGeneratedProfile", () => {
  it("cada campo do resultado vai para o seu lugar e o resto da configuração fica como está", () => {
    const withForm: AgentConfig = { ...filled, generator: { purpose: "sales", companyText: "Texto colado" } };
    const next = applyGeneratedProfile(withForm, profile);
    expect(next.knowledge.companyInfo).toBe(profile.companyInfo);
    expect(next.advanced.prompt).toBe(profile.instructions);
    expect(next.advanced.restrictions).toBe(profile.restrictions);
    expect(next.profile.description).toBe(profile.description);
    expect(next.profile.companySummary).toBe(profile.companySummary);
    expect(next.knowledge.examples).toHaveLength(9);
    // nome, modo, formulário guardado, ferramentas e recursos não mudam
    expect(next.name).toBe("Antigo");
    expect(next.profile.tone).toBe("formal");
    expect(next.generator).toEqual({ purpose: "sales", companyText: "Texto colado" });
    expect(next.advanced.tools).toEqual(filled.advanced.tools);
    expect(next.followUp).toBe(filled.followUp);
    expect(next.scheduling).toBe(filled.scheduling);
    expect(next.behavior).toBe(filled.behavior);
  });

  it("ao substituir as informações da empresa, zera produtos e FAQ antigos para não duplicar", () => {
    const next = applyGeneratedProfile(filled, profile);
    expect(next.knowledge.productsAndServices).toBe("");
    expect(next.knowledge.faq).toBe("");
    expect(agentConfigSchema.safeParse(next).success).toBe(true);
  });

  it("não altera a configuração original", () => {
    const before = JSON.stringify(filled);
    applyGeneratedProfile(filled, profile);
    expect(JSON.stringify(filled)).toBe(before);
  });

  it("'manter' preserva a seção inteira, uma por uma", () => {
    const keepCompany = applyGeneratedProfile(filled, profile, { company: "keep" });
    expect(keepCompany.knowledge.companyInfo).toBe("Texto antigo da empresa");
    expect(keepCompany.knowledge.productsAndServices).toBe("Produto antigo");
    expect(keepCompany.knowledge.faq).toBe("FAQ antigo");
    expect(keepCompany.profile.companySummary).toBe("Resumo antigo");
    expect(keepCompany.advanced.prompt).toBe(profile.instructions);

    const keepGoals = applyGeneratedProfile(filled, profile, { goals: "keep" });
    expect(keepGoals.profile.description).toBe("Descrição antiga");
    expect(keepGoals.advanced.prompt).toBe("Prompt antigo");
    expect(keepGoals.advanced.restrictions).toBe(profile.restrictions);

    const keepRestrictions = applyGeneratedProfile(filled, profile, { restrictions: "keep" });
    expect(keepRestrictions.advanced.restrictions).toBe("Restrição antiga");
    expect(keepRestrictions.advanced.prompt).toBe(profile.instructions);

    const keepExamples = applyGeneratedProfile(filled, profile, { examples: "keep" });
    expect(keepExamples.knowledge.examples).toEqual([{ customer: "Oi?", agent: "Olá!" }]);

    const keepAll = applyGeneratedProfile(filled, profile, { company: "keep", goals: "keep", restrictions: "keep", examples: "keep" });
    expect(keepAll).toEqual(filled);
  });

  it("descarta exemplos em branco e apara o texto", () => {
    const edited: GeneratedProfile = { ...profile, description: "  Descrição  ", restrictions: "  Sem preços  ", examples: [{ customer: " a ", agent: " b " }, { customer: "", agent: "" }] };
    const next = applyGeneratedProfile(empty, edited);
    expect(next.knowledge.examples).toEqual([{ customer: "a", agent: "b" }]);
    expect(next.profile.description).toBe("Descrição");
    expect(next.advanced.restrictions).toBe("Sem preços");
  });

  it("respeita os limites dos campos", () => {
    const big: GeneratedProfile = { ...profile, companyInfo: "x".repeat(13000), restrictions: "y".repeat(4000) };
    const next = applyGeneratedProfile(empty, big);
    expect(next.knowledge.companyInfo).toHaveLength(12000);
    expect(next.advanced.restrictions).toHaveLength(3000);
  });

  it("uma config antiga sem os campos novos continua válida e ganha os textos", () => {
    expect(empty.knowledge.examples).toBeUndefined();
    expect(agentConfigSchema.safeParse(empty).success).toBe(true);
    const next = applyGeneratedProfile(empty, profile);
    expect(next.knowledge.examples).toHaveLength(9);
    expect(next.knowledge.companyInfo).toBe(profile.companyInfo);
  });
});

describe("escolhas por seção", () => {
  it("o painel começa em 'substituir' e só conta as seções que serão trocadas", () => {
    expect(replaceAll()).toEqual({ company: "replace", goals: "replace", restrictions: "replace", examples: "replace" });
    expect(sectionsToReplace({ goals: "keep", examples: "keep" })).toEqual(["company", "restrictions"]);
    expect(sectionsToReplace({})).toEqual(["company", "goals", "restrictions", "examples"]);
    expect(sectionsToReplace({ company: "keep", goals: "keep", restrictions: "keep", examples: "keep" })).toEqual([]);
  });

  it("o aviso pós-geração é o combinado", () => {
    expect(GENERATED_NOTICE).toBe("Nada foi salvo ainda — teste no simulador, ajuste e salve.");
  });
});
