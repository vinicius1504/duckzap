import type { AgentJob, AgentTool, AgentConfig } from "@duckzap/contracts/agents";
import type { AgentDraft, AgentGoal, AgentTone, BusinessHour, CompanyStepInput } from "@duckzap/contracts/onboarding";

// Rascunho do agente do cadastro (objetivo, tom, o que vende, regras, quando chamar uma pessoa) → agente REAL do módulo
// Agentes. Funções puras (sem rede, sem banco): quem grava é `features/onboarding/agent-setup.ts`.

/** Nome do documento de conhecimento criado a partir de "O que você vende?". Fixo: é como o cadastro o reencontra ao refazer. */
export const OFFERING_DOCUMENT_NAME = "Produtos e serviços.txt";

const NAME_MAX = 60;

/** "Agente <empresa>" (limite de 60 caracteres do contrato). */
export function agentNameFor(companyName: string): string {
  const company = companyName.trim().replace(/\s+/g, " ");
  if (!company) return "Agente Duck";
  return `Agente ${company}`.slice(0, NAME_MAX).trim();
}

/**
 * Objetivo → trabalho do agente. Não existe um trabalho "vendas" no módulo Agentes (support, follow_up, scheduling,
 * instagram_dm, comments): vender é atender com foco em venda, então vira `support` com instruções de venda no prompt.
 */
export function jobForGoal(goal: AgentGoal): AgentJob {
  return goal === "scheduling" ? "scheduling" : "support";
}

const GOAL_DESCRIPTION: Record<AgentGoal, string> = {
  support: "Atende clientes, tira dúvidas e chama a equipe quando precisa",
  sales: "Apresenta o que a empresa vende e conduz o cliente até a compra",
  scheduling: "Marca e remarca horários e chama a equipe quando precisa",
};

const GOAL_INSTRUCTION: Record<AgentGoal, string> = {
  support: "Seu objetivo é atender os clientes e tirar dúvidas sobre a empresa.",
  sales: "Seu objetivo é vender: entenda o que o cliente procura, apresente as opções e conduza a conversa até o fechamento, sem pressionar.",
  scheduling: "Seu objetivo é agendar horários: ofereça dias e horários disponíveis e confirme o agendamento com o cliente.",
};

const TONE_INSTRUCTION: Record<AgentTone, string> = {
  friendly: "amigável e acolhedor",
  formal: "formal e respeitoso",
  direct: "direto e objetivo",
};

const GOAL_TOOLS: Record<AgentGoal, AgentTool[]> = {
  support: ["search_knowledge", "add_tag", "request_human"],
  sales: ["search_knowledge", "update_contact_fields", "add_tag", "request_human"],
  scheduling: ["search_knowledge", "list_available_slots", "book_appointment", "reschedule_appointment", "request_human"],
};

const DAY_NAMES: Record<BusinessHour["day"], string> = {
  mon: "segunda",
  tue: "terça",
  wed: "quarta",
  thu: "quinta",
  fri: "sexta",
  sat: "sábado",
  sun: "domingo",
};

/** "Atendemos de segunda a sexta, das 08:00 às 18:00; sábado, das 08:00 às 12:00." */
export function describeHours(hours: BusinessHour[]): string {
  const groups: { from: string; to: string; range: string }[] = [];
  hours.forEach((h, index) => {
    if (!h.open) return;
    const range = `das ${h.opensAt} às ${h.closesAt}`;
    const last = groups[groups.length - 1];
    const prev = hours[index - 1];
    if (last && last.range === range && prev?.open && DAY_NAMES[prev.day] === last.to) last.to = DAY_NAMES[h.day];
    else groups.push({ from: DAY_NAMES[h.day], to: DAY_NAMES[h.day], range });
  });
  if (groups.length === 0) return "No momento não temos horário de atendimento definido.";
  const parts = groups.map((g) => (g.from === g.to ? `${g.from}, ${g.range}` : `de ${g.from} a ${g.to}, ${g.range}`));
  return `Atendemos ${parts.join("; ")}.`;
}

/**
 * O texto padrão de "Quando chamar uma pessoa?" traz um espaço a preencher ("acima de R$ [VALOR]"). Se a pessoa não o
 * preencheu, o trecho com colchetes sai (nunca vai para o prompt do agente).
 */
export function stripPlaceholders(text: string): string {
  const parts = text
    // "A e B acima de R$ [VALOR]": o " e <trecho com colchetes>" sai e o que veio antes fica
    .replace(/\s+e\s+[^,;\n]*\[[^\]]*\][^,;\n]*/g, "")
    .split(/\s*[,;\n]\s*/)
    .map((p) => p.trim())
    .filter((p) => p && !/\[[^\]]*\]/.test(p));
  return parts
    .join(", ")
    .replace(/[.\s]+$/, "")
    .trim();
}

export type OnboardingAgentInput = {
  name: string;
  job: AgentJob;
  config: AgentConfig;
  /** Texto de "O que você vende?" para virar documento de conhecimento. */
  knowledge: { name: string; text: string; sizeBytes: number };
};

/**
 * @param bookableTypeIds tipos de atendimento da Agenda que o agente pode marcar (só no objetivo "Agendar"). Vazio = o agente
 * ainda não consegue marcar; a tela final avisa para cadastrar os tipos em Agenda.
 */
export function mapDraftToAgent(draft: AgentDraft, company: CompanyStepInput, bookableTypeIds: readonly string[] = []): OnboardingAgentInput {
  const name = agentNameFor(company.companyName);
  const companyName = company.companyName.trim();
  const offering = draft.offering.trim();
  const rules = draft.rules.trim();
  const handoff = stripPlaceholders(draft.handoffWhen);
  const canBook = draft.goal === "scheduling" && bookableTypeIds.length > 0;

  const prompt = [
    `Você é ${name}, assistente de atendimento da empresa ${companyName} no WhatsApp. Responda sempre em português, de forma ${TONE_INSTRUCTION[draft.tone]}, com mensagens curtas.`,
    GOAL_INSTRUCTION[draft.goal],
    `O que a empresa oferece: ${offering}`,
    rules ? `Regras importantes (siga sempre): ${rules}` : "",
    handoff ? `Chame uma pessoa da equipe quando: ${handoff}.` : "",
    "Nunca invente preços, prazos ou informações que você não tem. Se não souber, diga que vai chamar a equipe.",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);

  const config: AgentConfig = {
    name,
    profile: {
      description: GOAL_DESCRIPTION[draft.goal],
      tone: draft.tone,
      companySummary: `${companyName}. ${describeHours(company.businessHours)}`.slice(0, 2000),
    },
    knowledge: { productsAndServices: offering.slice(0, 5000), faq: "" },
    behavior: { respondWhen: "always", handoffOnRequest: true, handoffOnComplaint: true, handoffOnUnknown: true, creativity: 3, maxConsecutiveMessages: 6 },
    followUp: { enabled: false, steps: [], respectBusinessHours: true, stopOnReply: true },
    scheduling: { canBook, appointmentTypeIds: canBook ? [...bookableTypeIds] : [] },
    advanced: { prompt, tools: GOAL_TOOLS[draft.goal].filter((tool) => canBook || (tool !== "book_appointment" && tool !== "list_available_slots" && tool !== "reschedule_appointment")) },
  };

  const text = offering;
  return { name, job: jobForGoal(draft.goal), config, knowledge: { name: OFFERING_DOCUMENT_NAME, text, sizeBytes: new TextEncoder().encode(text).length } };
}

/**
 * Refazer o cadastro regrava a configuração do agente; o que o cadastro não pergunta e é do dono não pode sumir: os exemplos
 * de resposta, o formulário do gerador de perfil (`generator`, para "Gerar de novo" sem colar tudo outra vez) e os textos
 * "Informações da empresa" (`knowledge.companyInfo`) e "Restrições" (`advanced.restrictions`). Mantém os que o agente já tem.
 * (O nome `keepExamples` ficou porque é usado por `features/onboarding/agent-setup.ts`.)
 */
export function keepExamples(next: AgentConfig, previous: AgentConfig): AgentConfig {
  let kept = next;
  const examples = previous.knowledge.examples;
  if (examples?.length) kept = { ...kept, knowledge: { ...kept.knowledge, examples } };
  if (previous.knowledge.companyInfo?.trim()) kept = { ...kept, knowledge: { ...kept.knowledge, companyInfo: previous.knowledge.companyInfo } };
  if (previous.advanced.restrictions?.trim()) kept = { ...kept, advanced: { ...kept.advanced, restrictions: previous.advanced.restrictions } };
  if (previous.generator) kept = { ...kept, generator: previous.generator };
  return kept;
}

/** Comparação estável (ordem das chaves não importa): refazer o cadastro sem mudar nada não cria uma versão nova. */
export function sameConfig(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
