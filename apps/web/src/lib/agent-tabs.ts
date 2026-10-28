// Seções do editor do agente (seletor de cima do card, no modelo do MillionZap). O valor vai na URL (`?aba=`); os valores
// das telas antigas continuam abrindo o lugar para onde a função foi.

export const EDITOR_SECTIONS = [
  { value: "simples", label: "Configuração simples" },
  { value: "avancada", label: "Configuração avançada" },
  { value: "recursos", label: "Recursos" },
] as const;

export type EditorSection = (typeof EDITOR_SECTIONS)[number]["value"];
export const DEFAULT_EDITOR_SECTION: EditorSection = "simples";

/** Recursos (cartões da seção "Recursos"). */
export type ResourceId = "rules" | "tools" | "copilot";

/** Abas antigas → onde a função mora hoje. */
const LEGACY: Record<string, { section: EditorSection; resource?: ResourceId }> = {
  perfil: { section: "simples" },
  prompt: { section: "avancada" },
  dados: { section: "avancada" },
  conhecimento: { section: "avancada" },
  avancado: { section: "avancada" },
  comportamento: { section: "recursos", resource: "rules" },
  // Agenda é automática e o follow-up virou um cartão da página Agentes: o link antigo só abre Recursos
  "follow-up": { section: "recursos" },
  agenda: { section: "recursos" },
};

/** Seção para um valor vindo da URL (novo ou antigo). Desconhecido = a padrão. */
export function parseEditorSection(raw: string | null | undefined): EditorSection {
  const direct = EDITOR_SECTIONS.find((section) => section.value === raw)?.value;
  if (direct) return direct;
  return (raw ? LEGACY[raw]?.section : undefined) ?? DEFAULT_EDITOR_SECTION;
}

/** Cartão de Recursos que um link antigo (`?aba=agenda`…) quer ver aberto. */
export function legacyResource(raw: string | null | undefined): ResourceId | null {
  return (raw ? LEGACY[raw]?.resource : undefined) ?? null;
}

/** Para onde a tela vai depois de gerar: a configuração avançada, onde moram os textos gerados. */
export const AFTER_GENERATION_SECTION: EditorSection = "avancada";

/** Seção dos exemplos de resposta (para levar o usuário a um exemplo incompleto ao salvar). */
export const EXAMPLES_SECTION: EditorSection = "avancada";
