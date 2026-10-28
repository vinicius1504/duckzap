import type { ChannelType } from "@duckzap/contracts/channels";

export type PlanInfo = { maxChannels: number; features: readonly string[] };

/** §1.2: Instagram só quando o plano tem a feature `instagram` (Escala). */
export function allowedChannelTypes(plan: PlanInfo): ChannelType[] {
  return plan.features.includes("instagram") ? ["whatsapp_qr", "whatsapp_official", "instagram"] : ["whatsapp_qr", "whatsapp_official"];
}

export type CreateCheck = { ok: true } | { ok: false; code: "plan_limit" | "type_not_allowed"; message: string };

/** Regra pura de criação de canal (aplicada no back; a UI só reflete). */
export function checkCanCreate(plan: PlanInfo, used: number, type: ChannelType): CreateCheck {
  if (used >= plan.maxChannels) {
    return { ok: false, code: "plan_limit", message: `Seu plano permite ${plan.maxChannels} canais. Mude de plano para adicionar outro.` };
  }
  if (!allowedChannelTypes(plan).includes(type)) {
    return { ok: false, code: "type_not_allowed", message: "O Instagram está disponível no plano Escala." };
  }
  return { ok: true };
}
