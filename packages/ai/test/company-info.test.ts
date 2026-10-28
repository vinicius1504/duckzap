import { describe, expect, it } from "vitest";
import { buildRulesBlock, buildSystemPrompt, COMPANY_INFO_HEADER, RESTRICTIONS_HEADER, RULES_MARKER } from "../src";
import { runScenario, sampleConfig, type Scenario } from "../evals/harness";

const info = "## Sobre a empresa\nClínica Casa Alvorada.\n\n## Perguntas frequentes\nP: Atendem Unimed?\nR: Atendemos Unimed e Odontoprev.";
const restrictions = "- Nunca falar de concorrentes.\n- Não usar gírias.";

describe("prompt: Informações da empresa e Restrições", () => {
  it("sem os campos novos (ou vazios), o prompt é idêntico ao de antes", () => {
    const base = sampleConfig();
    const prompt = buildSystemPrompt(base);
    expect(prompt).not.toContain(COMPANY_INFO_HEADER);
    expect(prompt).not.toContain(RESTRICTIONS_HEADER);
    expect(buildSystemPrompt({ ...base, knowledge: { ...base.knowledge, companyInfo: "" }, advanced: { ...base.advanced, restrictions: "  " } })).toBe(prompt);
  });

  it("companyInfo entra em <conhecimento> e os campos legados continuam entrando (agentes antigos)", () => {
    const base = sampleConfig();
    const prompt = buildSystemPrompt({ ...base, knowledge: { ...base.knowledge, companyInfo: info } });
    const knowledge = prompt.slice(prompt.indexOf("<conhecimento>"));
    expect(knowledge).toContain(`${COMPANY_INFO_HEADER}\n${info}`);
    expect(knowledge).toContain("Produtos e serviços:");
    expect(knowledge).toContain("Perguntas frequentes:");
    expect(knowledge.indexOf(COMPANY_INFO_HEADER)).toBeLessThan(knowledge.indexOf("Produtos e serviços:"));
    // só companyInfo (agente novo): sem blocos legados vazios
    const only = buildSystemPrompt(sampleConfig({ knowledge: { productsAndServices: "", faq: "", companyInfo: info } }));
    expect(only).toContain(info);
    expect(only).not.toContain("Produtos e serviços:");
  });

  it("restrições ficam no bloco de persona/negócio, FORA das regras inviolaveis e de buildRulesBlock", () => {
    const base = sampleConfig();
    const config = { ...base, advanced: { ...base.advanced, restrictions } };
    const prompt = buildSystemPrompt(config);
    expect(prompt).toContain(`${RESTRICTIONS_HEADER}\n${restrictions}`);
    expect(prompt.indexOf(RESTRICTIONS_HEADER)).toBeLessThan(prompt.indexOf(RULES_MARKER));
    expect(buildRulesBlock(config)).toBe(buildRulesBlock(base));
    expect(buildRulesBlock(config)).not.toContain("concorrentes");
  });
});

describe("pipeline: companyInfo conta como conhecimento", () => {
  const scenario = (config = sampleConfig({ knowledge: { productsAndServices: "", faq: "", companyInfo: info } })): Scenario => ({
    id: "ci",
    description: "ci",
    history: [{ role: "customer", text: "Vocês atendem Unimed?" }],
    router: { intent: "question", confidence: 0.9 },
    model: ["Atendemos sim: Unimed e Odontoprev."],
    expect: {},
    config,
  });

  it("pergunta respondida só por companyInfo: não faz handoff 'fora do conhecimento'", async () => {
    const { result } = await runScenario(scenario());
    expect(result.handoff).toBeNull();
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("controle: sem companyInfo nem produtos/FAQ, a mesma pergunta cai em handoff por falta de conhecimento", async () => {
    const { result } = await runScenario(scenario(sampleConfig({ knowledge: { productsAndServices: "", faq: "" } })));
    expect(result.handoff?.kind).toBe("unknown_knowledge");
  });

  it("preço e link que estão em companyInfo são permitidos pelos guardrails", async () => {
    const config = sampleConfig({ knowledge: { productsAndServices: "", faq: "", companyInfo: `${info}\n\nClareamento a laser: a partir de R$ 600,00.\nSite: https://casaalvorada.com.br` } });
    const { result } = await runScenario({
      ...scenario(config),
      history: [{ role: "customer", text: "Quanto custa o clareamento a laser? Qual o site?" }],
      router: { intent: "buy", confidence: 0.9 },
      model: ["O clareamento a laser sai a partir de R$ 600,00. Mais em https://casaalvorada.com.br"],
    });
    expect(result.blocked).toEqual([]);
    expect(result.handoff).toBeNull();
  });
});
