import type { AgentConfig } from "@duckzap/contracts/agents";
import { describe, expect, it } from "vitest";
import { COMPANY_INFO_MAX, hasLegacyCompany, joinLegacyCompany, mergeLegacyCompany } from "./agent-company-info";

const base: AgentConfig = {
  name: "Duda",
  profile: { description: "", tone: "friendly", companySummary: "" },
  knowledge: { productsAndServices: "", faq: "" },
  behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
  followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
  scheduling: { canBook: false, appointmentTypeIds: [] },
  advanced: { prompt: "Instruções", tools: ["search_knowledge", "request_human"] },
};
const legacy: AgentConfig = {
  ...base,
  profile: { ...base.profile, companySummary: "A Casa Alvorada é uma clínica." },
  knowledge: { productsAndServices: "Limpeza\nClareamento", faq: "Aceitam Unimed? Sim." },
};

describe("mergeLegacyCompany", () => {
  it("monta um texto com as seções que têm conteúdo, na ordem, cada uma com o título", () => {
    expect(mergeLegacyCompany({ summary: "Resumo", products: "Sites", faq: "P: Oi?" })).toBe("Sobre a empresa\nResumo\n\nProdutos e serviços\nSites\n\nPerguntas frequentes\nP: Oi?");
  });

  it("pula as seções vazias e apara o texto", () => {
    expect(mergeLegacyCompany({ summary: "  ", products: " Sites ", faq: "" })).toBe("Produtos e serviços\nSites");
    expect(mergeLegacyCompany({ summary: "", products: "", faq: "" })).toBe("");
  });
});

describe("hasLegacyCompany", () => {
  it("só avisa quando há conteúdo antigo e as informações da empresa estão vazias", () => {
    expect(hasLegacyCompany(base)).toBe(false);
    expect(hasLegacyCompany(legacy)).toBe(true);
    expect(hasLegacyCompany({ ...legacy, knowledge: { ...legacy.knowledge, companyInfo: "   " } })).toBe(true);
    expect(hasLegacyCompany({ ...legacy, knowledge: { ...legacy.knowledge, companyInfo: "Já migrado" } })).toBe(false);
    expect(hasLegacyCompany({ ...base, knowledge: { ...base.knowledge, faq: "só FAQ" } })).toBe(true);
  });
});

describe("joinLegacyCompany ('Juntar em um texto')", () => {
  it("junta os três campos em companyInfo e esvazia os antigos; o resto não muda", () => {
    const { config, truncated } = joinLegacyCompany(legacy);
    expect(truncated).toBe(false);
    expect(config.knowledge.companyInfo).toBe(
      "Sobre a empresa\nA Casa Alvorada é uma clínica.\n\nProdutos e serviços\nLimpeza\nClareamento\n\nPerguntas frequentes\nAceitam Unimed? Sim.",
    );
    expect(config.knowledge.productsAndServices).toBe("");
    expect(config.knowledge.faq).toBe("");
    expect(config.profile.companySummary).toBe("");
    expect(config.advanced.prompt).toBe("Instruções");
    expect(config.name).toBe("Duda");
    expect(hasLegacyCompany(config)).toBe(false);
  });

  it("não altera a configuração original (nada some sem o clique)", () => {
    const before = JSON.stringify(legacy);
    joinLegacyCompany(legacy);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it("texto maior que o limite é cortado e avisa", () => {
    const huge: AgentConfig = { ...legacy, knowledge: { productsAndServices: "p".repeat(5000), faq: "f".repeat(5000) }, profile: { ...legacy.profile, companySummary: "s".repeat(2000) } };
    const joined = joinLegacyCompany({ ...huge, profile: { ...huge.profile, companySummary: "s".repeat(2000) } });
    expect((joined.config.knowledge.companyInfo ?? "").length).toBeLessThanOrEqual(COMPANY_INFO_MAX);
    const exact = joinLegacyCompany({ ...base, knowledge: { productsAndServices: "p".repeat(COMPANY_INFO_MAX), faq: "" } });
    expect(exact.truncated).toBe(true);
    expect(exact.config.knowledge.companyInfo).toHaveLength(COMPANY_INFO_MAX);
  });
});
