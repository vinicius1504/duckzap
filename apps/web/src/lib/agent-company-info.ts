import type { AgentConfig } from "@duckzap/contracts/agents";

export const COMPANY_INFO_MAX = 12_000; // igual a `knowledge.companyInfo` no contrato

// "Informações da empresa" é um texto só (`knowledge.companyInfo`). Agentes antigos guardam o mesmo conteúdo em três campos
// (resumo, produtos e serviços, perguntas frequentes): aqui está a junção deles, que só acontece quando a pessoa pede.

export const LEGACY_COMPANY_SECTIONS = {
  summary: "Sobre a empresa",
  products: "Produtos e serviços",
  faq: "Perguntas frequentes",
} as const;

/** Monta um texto único com as seções que têm conteúdo, cada uma com o próprio título. */
export function mergeLegacyCompany(parts: { summary: string; products: string; faq: string }): string {
  return (Object.keys(LEGACY_COMPANY_SECTIONS) as (keyof typeof LEGACY_COMPANY_SECTIONS)[])
    .map((key) => ({ title: LEGACY_COMPANY_SECTIONS[key], text: parts[key].trim() }))
    .filter((section) => section.text.length > 0)
    .map((section) => `${section.title}\n${section.text}`)
    .join("\n\n");
}

/** O agente tem conteúdo nos campos antigos e nada em "Informações da empresa"? */
export function hasLegacyCompany(config: Pick<AgentConfig, "profile" | "knowledge">): boolean {
  const legacy = config.profile.companySummary.trim() || config.knowledge.productsAndServices.trim() || config.knowledge.faq.trim();
  return Boolean(legacy) && !(config.knowledge.companyInfo ?? "").trim();
}

/**
 * "Juntar em um texto": o conteúdo dos três campos antigos vira `companyInfo` e os antigos ficam vazios (para não duplicar).
 * Se o texto passar do limite, é cortado no limite e `truncated` avisa.
 */
export function joinLegacyCompany(config: AgentConfig): { config: AgentConfig; truncated: boolean } {
  const merged = mergeLegacyCompany({ summary: config.profile.companySummary, products: config.knowledge.productsAndServices, faq: config.knowledge.faq });
  return {
    truncated: merged.length > COMPANY_INFO_MAX,
    config: {
      ...config,
      profile: { ...config.profile, companySummary: "" },
      knowledge: { ...config.knowledge, companyInfo: merged.slice(0, COMPANY_INFO_MAX), productsAndServices: "", faq: "" },
    },
  };
}
