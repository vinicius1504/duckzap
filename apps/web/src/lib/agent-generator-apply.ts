import { cleanExamples } from "./agent-examples";
import { COMPANY_INFO_MAX, mergeLegacyCompany } from "./agent-company-info";
import type { AgentConfig, AgentGeneratorOutput } from "@duckzap/contracts/agents";

// Leva o conteúdo gerado para a configuração do agente em edição, por seção. Funções puras. Nada é salvo aqui: o editor
// marca o resultado como alteração não salva e quem grava é o "Salvar" normal.

/** O que a geração escreve. `companyInfo` já vem resolvido (ver `toGeneratedProfile`). */
export type GeneratedProfile = Pick<AgentGeneratorOutput, "description" | "instructions" | "companySummary" | "companyInfo" | "restrictions" | "examples">;

export type GeneratorSection = "company" | "goals" | "restrictions" | "examples";
export type SectionChoice = "replace" | "keep";
export type SectionChoices = Record<GeneratorSection, SectionChoice>;

export const GENERATOR_SECTIONS: readonly GeneratorSection[] = ["company", "goals", "restrictions", "examples"];

/** Como cada seção aparece na confirmação e onde mora no editor. */
export const SECTION_LABELS: Record<GeneratorSection, { title: string; detail: string; where: string }> = {
  company: { title: "Informações da empresa", detail: "texto da empresa e resumo", where: "Configuração avançada" },
  goals: { title: "Objetivos e instruções", detail: "papel e instruções do agente", where: "Configuração avançada" },
  restrictions: { title: "Restrições", detail: "o que a IA não deve fazer", where: "Configuração avançada" },
  examples: { title: "Exemplos de resposta", detail: "pares de pergunta e resposta", where: "Configuração avançada" },
};

export const PROFILE_LIMITS = {
  description: 200,
  instructions: 8000,
  companySummary: 2000,
  companyInfo: COMPANY_INFO_MAX,
  restrictions: 3000,
} as const;

/**
 * Saída do gerador → o que a tela aplica. Um gerador que ainda devolva produtos e perguntas em campos separados (e
 * `companyInfo` vazio) tem esse conteúdo juntado num texto só, para nada se perder.
 */
export function toGeneratedProfile(output: AgentGeneratorOutput): GeneratedProfile {
  const companyInfo =
    output.companyInfo.trim() || mergeLegacyCompany({ summary: output.companySummary, products: output.productsAndServices, faq: output.faq });
  return {
    description: output.description,
    instructions: output.instructions,
    companySummary: output.companySummary,
    companyInfo,
    restrictions: output.restrictions,
    examples: output.examples.map((example) => ({ ...example })),
  };
}

/** Seções do agente que hoje já têm conteúdo (o que seria sobrescrito). Os campos antigos contam como "Informações da empresa". */
export function sectionsWithContent(config: AgentConfig): GeneratorSection[] {
  const sections: GeneratorSection[] = [];
  const legacy = config.profile.companySummary.trim() || config.knowledge.productsAndServices.trim() || config.knowledge.faq.trim();
  if ((config.knowledge.companyInfo ?? "").trim() || legacy) sections.push("company");
  if (config.profile.description.trim() || config.advanced.prompt.trim()) sections.push("goals");
  if ((config.advanced.restrictions ?? "").trim()) sections.push("restrictions");
  if ((config.knowledge.examples ?? []).length > 0) sections.push("examples");
  return sections;
}

/** Tamanho do conteúdo atual de cada seção, para a confirmação ("1.240 caracteres", "6 exemplos"). */
export function describeCurrentSection(config: AgentConfig, section: GeneratorSection): string {
  if (section === "examples") {
    const count = (config.knowledge.examples ?? []).length;
    return `${count} ${count === 1 ? "exemplo" : "exemplos"}`;
  }
  const chars =
    section === "company"
      ? (config.knowledge.companyInfo ?? "").length + config.profile.companySummary.length + config.knowledge.productsAndServices.length + config.knowledge.faq.length
      : section === "goals"
        ? config.profile.description.length + config.advanced.prompt.length
        : (config.advanced.restrictions ?? "").length;
  return `${chars.toLocaleString("pt-BR")} caracteres`;
}

/** Escolha inicial do painel de confirmação: substituir tudo. */
export function replaceAll(): SectionChoices {
  return { company: "replace", goals: "replace", restrictions: "replace", examples: "replace" };
}

/** Seções que a escolha realmente troca (as sem conteúdo hoje entram sempre). */
export function sectionsToReplace(choices: Partial<Record<GeneratorSection, SectionChoice>>): GeneratorSection[] {
  return GENERATOR_SECTIONS.filter((section) => (choices[section] ?? "replace") === "replace");
}

/**
 * Devolve uma configuração nova com as seções escolhidas substituídas (seção ausente em `choices` = "replace"):
 * - company → `knowledge.companyInfo` e `profile.companySummary`; os campos antigos (produtos e perguntas) ficam vazios para não duplicar;
 * - goals → `profile.description` e `advanced.prompt`;
 * - restrictions → `advanced.restrictions`;
 * - examples → `knowledge.examples`.
 * O restante (nome, modo, formulário guardado, follow-up, agenda, ferramentas…) não muda.
 */
export function applyGeneratedProfile(config: AgentConfig, profile: GeneratedProfile, choices: Partial<Record<GeneratorSection, SectionChoice>> = {}): AgentConfig {
  const replace = (section: GeneratorSection) => (choices[section] ?? "replace") === "replace";
  let next: AgentConfig = config;
  if (replace("company")) {
    next = {
      ...next,
      profile: { ...next.profile, companySummary: profile.companySummary.trim().slice(0, PROFILE_LIMITS.companySummary) },
      knowledge: { ...next.knowledge, companyInfo: profile.companyInfo.trim().slice(0, PROFILE_LIMITS.companyInfo), productsAndServices: "", faq: "" },
    };
  }
  if (replace("goals")) {
    next = {
      ...next,
      profile: { ...next.profile, description: profile.description.trim().slice(0, PROFILE_LIMITS.description) },
      advanced: { ...next.advanced, prompt: profile.instructions.trim().slice(0, PROFILE_LIMITS.instructions) },
    };
  }
  if (replace("restrictions")) {
    next = { ...next, advanced: { ...next.advanced, restrictions: profile.restrictions.trim().slice(0, PROFILE_LIMITS.restrictions) } };
  }
  if (replace("examples")) {
    next = { ...next, knowledge: { ...next.knowledge, examples: cleanExamples(profile.examples) } };
  }
  return next;
}

/** Frase do aviso depois de aplicar. */
export const GENERATED_NOTICE = "Nada foi salvo ainda — teste no simulador, ajuste e salve.";
