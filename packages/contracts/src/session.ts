import { z } from "zod";

export const memberRoleSchema = z.enum(["owner", "admin", "agent"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

/** Planos de catálogo (seed): Básico, Pro e Empresarial. O slug de um plano é livre (o Painel Admin cria planos personalizados). */
export const planSlugSchema = z.enum(["basico", "pro", "empresarial"]);
export type CatalogPlanSlug = z.infer<typeof planSlugSchema>;
/** Slug de plano: livre (planos personalizados do Painel Admin). Para os 3 de catálogo veja `CatalogPlanSlug`. */
export type PlanSlug = string;

export const subscriptionStatusSchema = z.enum(["trial", "active", "past_due", "expired", "canceled"]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const sessionSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.email(),
    role: memberRoleSchema,
    /** A pessoa já ativou a verificação em duas etapas. Opcional: respostas antigas não trazem. */
    twoFactorEnabled: z.boolean().optional(),
    /** Proprietário/Administrador sem 2FA: o resto da API responde 403 `two_factor_required` até ativar (§5.1). */
    twoFactorRequired: z.boolean().optional(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
    /** Slug do plano da empresa; livre (plano personalizado criado pelo Painel Admin). Limites vêm de `plans`. */
    plan: z.string(),
    /** Recursos do plano (`campaigns`, `instagram`, `copilot`, `byo_ai`…): a tela decide por recurso, nunca pelo slug. */
    features: z.array(z.string()).default([]),
    /** Limite de agentes do plano; `null` = ilimitado. */
    maxAgents: z.number().int().nullable().default(null),
    subscriptionStatus: subscriptionStatusSchema,
    timeZone: z.string(),
  }),
});

export type Session = z.infer<typeof sessionSchema>;

/** Plano expirado: leitura liberada, envio pausado (§1.1, módulo Entrar). */
export function isSendingPaused(session: Session) {
  return isSendingPausedStatus(session.organization.subscriptionStatus);
}

/** Tolerância (em dias) depois do vencimento: nesse período a conta ainda usa tudo ("pague até amanhã"). */
export const GRACE_DAYS = 1;
const PLATFORM_TIME_ZONE = "America/Sao_Paulo";

function platformDay(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PLATFORM_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  const [y, m, d] = parts.split("-").map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Dias de atraso em relação ao vencimento, contados em dias do fuso da plataforma (o dia do vencimento não é atraso). */
export function daysLate(currentPeriodEnd: Date, now: Date): number {
  return platformDay(now) - platformDay(currentPeriodEnd);
}

/**
 * Status efetivo da assinatura, a MESMA regra do Painel Admin (`companyStatusOf`), contando dias do fuso do Brasil:
 *  - desativada pelo admin ou cancelada: `canceled`;
 *  - até o dia do vencimento: o status guardado (`trial`/`active`/`past_due`);
 *  - 1 dia depois do vencimento (tolerância): `past_due`, ainda usa tudo;
 *  - depois disso: `expired`; `expired` guardado também é `expired`.
 * `expired` e `canceled` = conta SUSPENDIDA (ver `isAccountSuspended`).
 */
export function effectiveSubscriptionStatus(input: {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  disabledAt?: Date | null;
  now: Date;
}): SubscriptionStatus {
  if (input.disabledAt || input.status === "canceled") return "canceled";
  if (input.status === "expired") return "expired";
  const late = daysLate(input.currentPeriodEnd, input.now);
  if (late <= 0) return input.status;
  return late <= GRACE_DAYS ? "past_due" : "expired";
}

/** Conta suspendida (`expired`/`canceled`): bloqueio TOTAL, não só do envio. */
export function isAccountSuspended(status: SubscriptionStatus) {
  return status === "expired" || status === "canceled";
}

/** Envio de mensagens/campanhas pausado: só conta suspendida (`past_due` na tolerância ainda envia). */
export function isSendingPausedStatus(status: SubscriptionStatus) {
  return isAccountSuspended(status);
}
