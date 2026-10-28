import { effectiveSubscriptionStatus, type SubscriptionStatus } from "@duckzap/contracts/session";
import { schema, type Database, type Transaction } from "@duckzap/db";
import { eq } from "drizzle-orm";

/**
 * FONTE ÚNICA do plano de uma empresa (§1.2): `subscriptions → plans`. Agentes, Canais, Equipe, Conversas/IA e Campanhas
 * leem os limites daqui (antes cada módulo resolvia de um jeito, e plano personalizado caía em "essencial").
 * O slug é livre: um plano criado no Painel Admin funciona sem mudar código.
 */
export type ResolvedPlan = {
  slug: string;
  limits: {
    channels: number;
    users: number;
    /** null = ilimitado. */
    agents: number | null;
  };
  features: string[];
  /** Orçamento mensal de tokens de IA. null = ilimitado. */
  monthlyTokenLimit: number | null;
  /** Status efetivo (vencimento aplicado). `null` = empresa sem assinatura. */
  status: SubscriptionStatus | null;
};

/** Empresa sem assinatura/plano: o mais restrito possível (nada liberado). */
export const NO_PLAN: ResolvedPlan = {
  slug: "none",
  limits: { channels: 0, users: 0, agents: 0 },
  features: [],
  monthlyTokenLimit: 0,
  status: null,
};

type PlanRow = typeof schema.plans.$inferSelect;
type SubscriptionRow = typeof schema.subscriptions.$inferSelect;

/** Pura: monta o plano resolvido a partir das duas linhas. */
export function planFromRows(plan: PlanRow | undefined, subscription: SubscriptionRow | undefined, now = new Date()): ResolvedPlan {
  if (!plan) return NO_PLAN;
  return {
    slug: plan.slug,
    limits: { channels: plan.maxChannels, users: plan.maxUsers, agents: plan.maxAgents },
    features: [...plan.features],
    monthlyTokenLimit: plan.monthlyTokenLimit,
    status: subscription
      ? effectiveSubscriptionStatus({
          status: subscription.status as SubscriptionStatus,
          currentPeriodEnd: subscription.currentPeriodEnd,
          disabledAt: subscription.disabledAt,
          now,
        })
      : null,
  };
}

/**
 * Plano da empresa. `tx` é uma transação `withOrg(...)` (a assinatura tem RLS); passar `db` direto só vale
 * com `organizationId` explícito, que filtramos aqui também (defesa em profundidade).
 */
export async function resolvePlan(tx: Transaction | Database, organizationId: string, now = new Date()): Promise<ResolvedPlan> {
  const [row] = await tx
    .select({ subscription: schema.subscriptions, plan: schema.plans })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.subscriptions.planSlug, schema.plans.slug))
    .where(eq(schema.subscriptions.organizationId, organizationId))
    .limit(1);
  return planFromRows(row?.plan, row?.subscription, now);
}

/** Limite de tokens como número para `tokenBudget(..., overrideLimit)`: null (ilimitado) vira "praticamente infinito". */
export function tokenLimitValue(plan: Pick<ResolvedPlan, "monthlyTokenLimit">): number {
  return plan.monthlyTokenLimit ?? Number.MAX_SAFE_INTEGER;
}
