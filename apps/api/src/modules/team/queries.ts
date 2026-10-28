import type { MemberRole } from "@duckzap/contracts/session";
import { schema, type Transaction } from "@duckzap/db";
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { resolvePlan } from "../../lib/plan";
import { fromBetterAuthRole } from "./rules";

/**
 * `member` e `invitation` são tabelas do Better Auth SEM RLS: TODA consulta aqui filtra por
 * `organization_id` explicitamente. Não existe query nesta pasta que leia essas tabelas sem esse filtro
 * (exceto `findInvitationForAccept`, que parte do id secreto do convite e já traz a empresa dele).
 */

export type MemberRow = {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  twoFactorEnabled: boolean;
  phone: string | null;
  active: boolean;
};

export async function lockOrg(tx: Transaction, organizationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);
}

export async function listMemberRows(tx: Transaction, organizationId: string): Promise<MemberRow[]> {
  const rows = await tx
    .select({
      userId: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.member.role,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(eq(schema.member.organizationId, organizationId));
  const profiles = await tx
    .select({ userId: schema.memberProfiles.userId, phone: schema.memberProfiles.phone, active: schema.memberProfiles.active })
    .from(schema.memberProfiles)
    .where(eq(schema.memberProfiles.organizationId, organizationId));
  const byUser = new Map(profiles.map((p) => [p.userId, p]));
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    email: r.email,
    role: fromBetterAuthRole(r.role),
    twoFactorEnabled: Boolean(r.twoFactorEnabled),
    phone: byUser.get(r.userId)?.phone ?? null,
    active: byUser.get(r.userId)?.active ?? true,
  }));
}

export async function findMemberRow(tx: Transaction, organizationId: string, userId: string): Promise<MemberRow | null> {
  const rows = await listMemberRows(tx, organizationId);
  return rows.find((r) => r.userId === userId) ?? null;
}

export type InviteRow = {
  id: string;
  email: string;
  role: MemberRole;
  name: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
};

export async function listPendingInvites(tx: Transaction, organizationId: string): Promise<InviteRow[]> {
  const rows = await tx
    .select({
      id: schema.invitation.id,
      email: schema.invitation.email,
      role: schema.invitation.role,
      status: schema.invitation.status,
      createdAt: schema.invitation.createdAt,
      expiresAt: schema.invitation.expiresAt,
      name: schema.inviteProfiles.name,
    })
    .from(schema.invitation)
    .leftJoin(schema.inviteProfiles, eq(schema.inviteProfiles.invitationId, schema.invitation.id))
    .where(and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.status, "pending")));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: fromBetterAuthRole(r.role ?? "member"),
    name: r.name ?? r.email.split("@")[0] ?? r.email,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));
}

/** Convite de uma empresa pelo id, em qualquer status (ou null se for de outra empresa). */
export async function findInvite(tx: Transaction, organizationId: string, invitationId: string) {
  const [row] = await tx
    .select({
      id: schema.invitation.id,
      email: schema.invitation.email,
      role: schema.invitation.role,
      status: schema.invitation.status,
      expiresAt: schema.invitation.expiresAt,
    })
    .from(schema.invitation)
    .where(and(eq(schema.invitation.organizationId, organizationId), eq(schema.invitation.id, invitationId)))
    .limit(1);
  return row ? { ...row, role: fromBetterAuthRole(row.role ?? "member") } : null;
}

/** Último acesso aproximado: a sessão mais recente da pessoa. */
export async function lastActiveByUser(tx: Transaction, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, Date>();
  const rows = await tx
    .select({ userId: schema.session.userId, last: max(schema.session.updatedAt) })
    .from(schema.session)
    .where(inArray(schema.session.userId, userIds))
    .groupBy(schema.session.userId);
  const map = new Map<string, Date>();
  for (const r of rows) if (r.last) map.set(r.userId, r.last);
  return map;
}

/** Limite de usuários do plano (fonte única: `lib/plan.ts`); empresa sem plano = 0. */
export async function maxUsersForPlan(tx: Transaction, organizationId: string): Promise<number | null> {
  return (await resolvePlan(tx, organizationId)).limits.users;
}

/** Usuários que contam no plano: ativos + convites pendentes (inativos não contam). */
export async function countUsers(tx: Transaction, organizationId: string) {
  const members = await listMemberRows(tx, organizationId);
  const invites = await listPendingInvites(tx, organizationId);
  return members.filter((m) => m.active).length + invites.length;
}

export async function listTeamRows(tx: Transaction, organizationId: string) {
  return tx.select().from(schema.teams).where(eq(schema.teams.organizationId, organizationId));
}

export async function listTeamLinks(tx: Transaction, organizationId: string) {
  return tx
    .select({ teamId: schema.teamMembers.teamId, memberRef: schema.teamMembers.memberRef })
    .from(schema.teamMembers)
    .where(eq(schema.teamMembers.organizationId, organizationId));
}

export async function upsertProfile(
  tx: Transaction,
  organizationId: string,
  userId: string,
  id: string,
  values: Partial<{
    active: boolean;
    deactivatedAt: Date | null;
    phone: string | null;
    twoFactorEnabledAt: Date | null;
    notifications: { sound: boolean; browser: boolean; emailSummary: boolean };
  }>,
) {
  await tx
    .insert(schema.memberProfiles)
    .values({ id, organizationId, userId, ...values })
    .onConflictDoUpdate({
      target: [schema.memberProfiles.organizationId, schema.memberProfiles.userId],
      set: { ...values, updatedAt: new Date() },
    });
}
