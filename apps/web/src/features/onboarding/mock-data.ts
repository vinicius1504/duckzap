import type { AgentDraft, BusinessHour, CompanyStepInput } from "@duckzap/contracts/onboarding";

/**
 * Dados de exemplo do onboarding (do design Onboarding.dc.html). Só `api.ts` importa este arquivo.
 *
 * A conta, a empresa e o WhatsApp (QR ou API oficial) do cadastro são REAIS (API e módulo Canais).
 * Continua de exemplo só o passo do agente de teste (prévia da conversa e rascunho).
 */

export const defaultBusinessHours: BusinessHour[] = [
  { day: "mon", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "tue", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "wed", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "thu", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "fri", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "sat", open: true, opensAt: "08:00", closesAt: "12:00" },
  { day: "sun", open: false, opensAt: "", closesAt: "" },
];

export function defaultCompany(name = ""): CompanyStepInput {
  return {
    companyName: name,
    businessHours: defaultBusinessHours,
    welcomeMessage: "",
  };
}

export const defaultAgent: AgentDraft = {
  goal: "support",
  tone: "friendly",
  offering: "",
  rules: "",
  handoffWhen: "Reclamações, urgências e pedidos de orçamento acima de R$ [VALOR].",
};

/** Pergunta de exemplo que abre a prévia do agente. */
export const sampleQuestion = "Quanto custa?";
