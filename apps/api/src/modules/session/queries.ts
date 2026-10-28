import type { MemberRole, Session, SubscriptionStatus } from "@duckzap/contracts/session";
import { effectiveSubscriptionStatus, subscriptionStatusSchema } from "@duckzap/contracts/session";
import { schema, withOrg, type Database } from "@duckzap/db";
import { eq } from "drizzle-orm";
import type { AuthSession } from "../../lib/context";
import { loadSecurityConfig } from "../../middleware/security-config";
import { isTwoFactorEnabled, needsTwoFactor } from "../../middleware/two-factor";

// Better Auth usa "member" para o papel base; no produto ele é o Atendente.
function toMemberRole(role: string): MemberRole {
  if (role === "owner" || role === "admin") return role;
  return "agent";
}

export type SessionResult = { ok: true; session: Session } | { ok: false; code: "no_organization" };

export async function buildSession(
  db: Database,
  auth: AuthSession,
  now = new Date(),
  options: { require2fa?: boolean } = {},
): Promise<SessionResult> {
  const memberships = await db
    .select({ role: schema.member.role, org: schema.organization })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, auth.user.id));

  const active =
    memberships.find((m) => m.org.id === auth.session.activeOrganizationId) ?? memberships[0];
  if (!active) return { ok: false, code: "no_organization" };

  const [subscription] = await withOrg(db, active.org.id, (tx) =>
    tx.select().from(schema.subscriptions).limit(1),
  );

  // o slug é livre (plano personalizado do Painel Admin); sem assinatura, nada é liberado
  const plan = subscription?.planSlug ?? "none";
  const [planRow] = subscription
    ? await db.select().from(schema.plans).where(eq(schema.plans.slug, plan)).limit(1)
    : [];
  // mesma regra do Painel Admin (tolerância de 10 dias; depois pausa o envio)
  const status: SubscriptionStatus = subscription
    ? effectiveSubscriptionStatus({
        status: subscriptionStatusSchema.catch("expired").parse(subscription.status),
        currentPeriodEnd: subscription.currentPeriodEnd,
        disabledAt: subscription.disabledAt,
        now,
      })
    : "expired";

  return {
    ok: true,
    session: {
      user: {
        id: auth.user.id,
        name: auth.user.name,
        email: auth.user.email,
        role: toMemberRole(active.role),
        twoFactorEnabled: isTwoFactorEnabled(auth),
        twoFactorRequired: needsTwoFactor({
          role: toMemberRole(active.role),
          twoFactorEnabled: isTwoFactorEnabled(auth),
          required: options.require2fa ?? loadSecurityConfig().require2faForAdmins,
        }),
      },
      organization: {
        id: active.org.id,
        name: active.org.name,
        plan,
        features: planRow?.features ?? [],
        // null = ilimitado (não use `??`: null tem significado). Sem plano: o mais restrito
        maxAgents: planRow ? planRow.maxAgents : 1,
        subscriptionStatus: status,
        timeZone: active.org.timeZone ?? "America/Sao_Paulo",
      },
    },
  };
}
