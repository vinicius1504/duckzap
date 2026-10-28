import { createDb, schema } from "@duckzap/db";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

/**
 * Apoio a testes de integração: uma SEGUNDA empresa ATIVA, criada pelo próprio teste (plano `basico`, vence no futuro),
 * para os cenários de "outra empresa". A `org_lume` do seed está EXPIRADA de propósito (conta suspensa = 403 em tudo) e só
 * serve para testar a suspensão. Usa o dono do banco (`DATABASE_ADMIN_URL`): o papel do app não cria empresa nem pessoa.
 */
export type SecondOrg = {
  orgId: string;
  userId: string;
  userName: string;
  userEmail: string;
  /** Pessoas extras pedidas em `extra` (por chave). */
  members: Record<string, { userId: string; name: string; email: string }>;
  remove: () => Promise<void>;
};

export const hasSecondOrgSupport = () => Boolean(process.env.DATABASE_ADMIN_URL);

export async function createSecondOrg(
  label: string,
  options: { planSlug?: string; role?: "owner" | "admin" | "member"; status?: "trial" | "active" | "past_due" | "expired" | "canceled"; daysToEnd?: number; ownerName?: string; extra?: { key: string; role: "owner" | "admin" | "member"; name?: string }[] } = {},
): Promise<SecondOrg> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL é necessário para criar a segunda empresa de teste.");
  const suffix = uuidv7().slice(-10);
  const orgId = `org_it_${label}_${suffix}`;
  const userId = `usr_it_${label}_${suffix}`;
  const userName = options.ownerName ?? `Dona ${label}`;
  const userEmail = `${userId}@example.test`;
  const members: SecondOrg["members"] = {};
  for (const e of options.extra ?? []) members[e.key] = { userId: `usr_it_${label}_${e.key}_${suffix}`, name: e.name ?? `${e.key} ${label}`, email: `usr_it_${label}_${e.key}_${suffix}@example.test` };
  const { db, close } = createDb(url, { max: 1 });
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.organization).values({ id: orgId, name: `Empresa ${label} ${suffix}`, slug: `it-${label}-${suffix}`.toLowerCase(), createdAt: now, timeZone: "America/Sao_Paulo" });
      await tx.insert(schema.user).values({ id: userId, name: userName, email: userEmail, emailVerified: true, createdAt: now, updatedAt: now });
      await tx.insert(schema.member).values({ id: `mem_${userId}`, organizationId: orgId, userId, role: options.role ?? "owner", createdAt: now });
      for (const e of options.extra ?? []) {
        const m = members[e.key]!;
        await tx.insert(schema.user).values({ id: m.userId, name: m.name, email: m.email, emailVerified: true, createdAt: now, updatedAt: now });
        await tx.insert(schema.member).values({ id: `mem_${m.userId}`, organizationId: orgId, userId: m.userId, role: e.role, createdAt: now });
      }
      await tx.insert(schema.subscriptions).values({
        id: uuidv7(),
        organizationId: orgId,
        planSlug: options.planSlug ?? "basico",
        status: options.status ?? "active",
        currentPeriodEnd: new Date(now.getTime() + (options.daysToEnd ?? 20) * 86_400_000),
      });
    });
  } finally {
    await close();
  }
  return {
    orgId,
    userId,
    userName,
    userEmail,
    members,
    remove: async () => {
      const owner = createDb(url, { max: 1 });
      try {
        await owner.db.delete(schema.organization).where(eq(schema.organization.id, orgId)); // cascata: member, assinatura, dados da empresa
        for (const id of [userId, ...Object.values(members).map((m) => m.userId)]) await owner.db.delete(schema.user).where(eq(schema.user.id, id));
      } finally {
        await owner.close();
      }
    },
  };
}
