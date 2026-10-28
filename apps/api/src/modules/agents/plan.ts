import { INSTAGRAM_JOBS, type AgentJob } from "@duckzap/contracts/agents";

/** Regras de plano (§1.2) — puras; aplicadas no servidor, a UI só reflete. Os limites vêm da tabela `plans`. */
export type PlanInfo = { maxAgents: number | null; features: readonly string[] };

export type PlanCheck = { ok: true } | { ok: false; code: "plan_limit" | "plan_feature"; message: string };

export function jobNeedsInstagram(job: AgentJob) {
  return INSTAGRAM_JOBS.includes(job);
}

export function checkCanCreateAgent(plan: PlanInfo, currentAgents: number, job: AgentJob): PlanCheck {
  if (jobNeedsInstagram(job) && !plan.features.includes("instagram")) {
    return { ok: false, code: "plan_feature", message: "Instagram faz parte dos planos Pro e Empresarial." };
  }
  if (plan.maxAgents !== null && currentAgents >= plan.maxAgents) {
    return {
      ok: false,
      code: "plan_limit",
      message: `Seu plano permite ${plan.maxAgents} ${plan.maxAgents === 1 ? "agente" : "agentes"}. Mude para o Pro para ter agentes ilimitados.`,
    };
  }
  return { ok: true };
}

export function checkCanActivate(plan: PlanInfo, job: AgentJob): PlanCheck {
  if (jobNeedsInstagram(job) && !plan.features.includes("instagram")) {
    return { ok: false, code: "plan_feature", message: "Instagram faz parte dos planos Pro e Empresarial." };
  }
  return { ok: true };
}

export function checkCopilotAllowed(plan: PlanInfo): PlanCheck {
  return plan.features.includes("copilot") ? { ok: true } : { ok: false, code: "plan_feature", message: "O Copiloto faz parte do plano Empresarial." };
}

/** Agente de Instagram numa empresa que perdeu o recurso aparece como pausado pelo sistema (não grava nada). */
export function effectiveStatus(
  stored: { status: "active" | "paused" | "inactive"; pausedReason: "plan_feature" | "manual" | null },
  job: AgentJob,
  plan: PlanInfo,
) {
  if (stored.status === "active" && jobNeedsInstagram(job) && !plan.features.includes("instagram")) {
    return { status: "paused" as const, pausedReason: "plan_feature" as const };
  }
  return stored;
}
