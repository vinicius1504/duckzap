import type { Plan, PlanFeature } from "@duckzap/contracts/admin";

export const planFeatureLabels: Record<PlanFeature, string> = {
  campaigns: "Campanhas",
  instagram: "Instagram",
  copilot: "Copiloto",
};

export const planFeatureOrder: readonly PlanFeature[] = ["campaigns", "instagram", "copilot"];

/** "5 canais · 5 usuários · Campanhas" (como no design; agentes ilimitados não aparecem). */
export function planResourcesText(plan: Pick<Plan, "limits" | "features">) {
  const parts = [
    `${plan.limits.channels} ${plan.limits.channels === 1 ? "canal" : "canais"}`,
    `${plan.limits.users} ${plan.limits.users === 1 ? "usuário" : "usuários"}`,
  ];
  if (plan.limits.agents !== null)
    parts.push(`${plan.limits.agents} ${plan.limits.agents === 1 ? "agente" : "agentes"}`);
  for (const feature of planFeatureOrder)
    if (plan.features[feature]) parts.push(planFeatureLabels[feature]);
  return parts.join(" · ");
}
