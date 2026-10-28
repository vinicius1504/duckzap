import { schema, withOrg, type Database } from "@duckzap/db";
import { and, eq } from "drizzle-orm";

/**
 * Pessoa inativa não entra: usado no gancho de criação de sessão do Better Auth (auth.ts).
 * Bloqueia só quando a pessoa tem empresa(s) e está inativa em TODAS; quem ainda não tem empresa
 * (cadastro em andamento) ou tem alguma empresa ativa passa.
 */
export async function hasOnlyInactiveMemberships(db: Database, userId: string): Promise<boolean> {
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  if (memberships.length === 0) return false;
  for (const { organizationId } of memberships) {
    const [profile] = await withOrg(db, organizationId, (tx) =>
      tx
        .select({ active: schema.memberProfiles.active })
        .from(schema.memberProfiles)
        .where(and(eq(schema.memberProfiles.organizationId, organizationId), eq(schema.memberProfiles.userId, userId)))
        .limit(1),
    );
    if (!profile || profile.active) return false;
  }
  return true;
}
