import { brand } from "@duckzap/brand";
import type { InviteMemberInput, Member, Team, TeamInput, TeamOverview, UpdateMemberInput } from "@duckzap/contracts/team";
import { businessHoursSchema } from "@duckzap/contracts/settings";
import { schema, withOrg, type Database, type Transaction } from "@duckzap/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { agentIdByTeam, channelIdsByTeam, dbLinks, setTeamAgent, setTeamChannels } from "../channels/links";
import type { Deps } from "../../lib/context";
import type { Actor } from "./http";
import { makeInviteToken } from "./invite-token";
import {
  countUsers,
  findInvite,
  findMemberRow,
  lastActiveByUser,
  listMemberRows,
  listPendingInvites,
  listTeamLinks,
  listTeamRows,
  lockOrg,
  maxUsersForPlan,
  upsertProfile,
} from "./queries";
import { errRes, mailerFor, okRes, type Res } from "./result";
import {
  canManageMember,
  canAssignRole,
  checkDeactivate,
  checkReactivate,
  checkRoleChange,
  isOverUserLimit,
  toBetterAuthRole,
} from "./rules";

type Ctx = { deps: Deps; actor: Actor; headers: Headers };

const limitMessage = (max: number) => `Seu plano permite ${max} usuários. Inative alguém ou mude de plano.`;

// ---------- Visão geral ----------

export async function getTeamOverview({ deps, actor }: Omit<Ctx, "headers">): Promise<TeamOverview> {
  return withOrg(deps.db, actor.organizationId, async (tx) => {
    const org = actor.organizationId;
    // um `tx` é uma única conexão: as consultas rodam em sequência
    const members = await listMemberRows(tx, org);
    const invites = await listPendingInvites(tx, org);
    const teamRows = await listTeamRows(tx, org);
    const links = await listTeamLinks(tx, org);
    const maxUsers = await maxUsersForPlan(tx, org);
    // canais e agente da equipe: derivados de `channels.team_id`/`channels.agent_id` (única fonte de verdade)
    const channelsByTeam = await channelIdsByTeam(tx, org);
    const agentByTeam = await agentIdByTeam(tx, org);
    const channelRows = await tx
      .select({ id: schema.channels.id, name: schema.channels.name })
      .from(schema.channels)
      .where(eq(schema.channels.organizationId, org))
      .orderBy(schema.channels.createdAt);
    const agentOptions = await dbLinks.listAgents(tx, org);
    const lastActive = await lastActiveByUser(
      tx,
      members.map((m) => m.userId),
    );
    const teamsOf = (ref: string) => links.filter((l) => l.memberRef === ref).map((l) => l.teamId);

    const people: Member[] = [
      ...members.map(
        (m): Member => ({
          id: m.userId,
          name: m.name,
          email: m.email,
          phone: m.phone,
          role: m.role,
          status: m.active ? "active" : "inactive",
          teamIds: teamsOf(m.userId),
          twoFactorEnabled: m.twoFactorEnabled,
          invitedAt: null,
          lastActiveAt: lastActive.get(m.userId)?.toISOString() ?? null,
        }),
      ),
      ...invites.map(
        (i): Member => ({
          id: i.id,
          name: i.name,
          email: i.email,
          phone: null,
          role: i.role,
          status: "invited",
          teamIds: teamsOf(i.id),
          twoFactorEnabled: false,
          invitedAt: i.createdAt.toISOString(),
          lastActiveAt: null,
        }),
      ),
    ];

    const teams: Team[] = teamRows
      .sort((a, b) => a.priority - b.priority)
      .map((t) =>
        toTeam(t, links.filter((l) => l.teamId === t.id).map((l) => l.memberRef), channelsByTeam.get(t.id) ?? [], agentByTeam.get(t.id) ?? null),
      );

    return {
      members: people,
      teams,
      channels: channelRows,
      agents: agentOptions,
      userLimit: { used: members.filter((m) => m.active).length + invites.length, max: maxUsers },
    };
  });
}

function toTeam(t: typeof schema.teams.$inferSelect, memberIds: string[], channelIds: string[], agentId: string | null): Team {
  const hours = businessHoursSchema.safeParse(t.businessHours);
  return {
    id: t.id,
    name: t.name,
    color: t.color as Team["color"],
    priority: t.priority,
    businessHours: hours.success ? hours.data : defaultHours(),
    greeting: t.greeting,
    outOfHoursMessage: t.outOfHoursMessage,
    memberIds,
    channelIds,
    agentId,
  };
}

export function defaultHours(): Team["businessHours"] {
  return ([0, 1, 2, 3, 4, 5, 6] as const).map((day) => ({
    day,
    open: day >= 1 && day <= 5,
    start: "08:00",
    end: "18:00",
  }));
}

// ---------- Convites ----------

export async function inviteMember(ctx: Ctx, input: InviteMemberInput): Promise<Res<Member>> {
  const { deps, actor } = ctx;
  if (!canAssignRole(actor.role, input.role)) {
    return errRes(403, "forbidden", "Só o proprietário pode convidar outro proprietário.");
  }
  const email = input.email.trim().toLowerCase();

  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<Member>> => {
    const org = actor.organizationId;
    await lockOrg(tx, org); // serializa convites/reativações da empresa: o limite do plano não estoura em corrida

    const members = await listMemberRows(tx, org);
    const invites = await listPendingInvites(tx, org);
    if (members.some((m) => m.email.toLowerCase() === email) || invites.some((i) => i.email.toLowerCase() === email)) {
      return errRes(409, "duplicate_email", "Já existe alguém com esse e-mail na equipe.");
    }
    const maxUsers = await maxUsersForPlan(tx, org);
    const used = members.filter((m) => m.active).length + invites.length;
    if (maxUsers !== null && isOverUserLimit(used, maxUsers)) return errRes(403, "plan_limit", limitMessage(maxUsers));

    const teamCheck = await assertTeamsExist(tx, org, input.teamIds);
    if (!teamCheck.ok) return teamCheck;

    // o Better Auth cria o convite (e valida papel/duplicidade por conta própria)
    const created = await deps.auth.api.createInvitation({
      headers: ctx.headers,
      body: { email, role: toBetterAuthRole(input.role), organizationId: org },
    });
    if (!created?.id) throw new Error("Falha ao criar o convite");

    await tx.insert(schema.inviteProfiles).values({ invitationId: created.id, organizationId: org, name: input.name });
    await setMemberTeams(tx, org, created.id, input.teamIds);

    await sendInviteMail(deps, { id: created.id, email, name: input.name, organizationName: await orgName(deps.db, org), inviterName: actor.name });

    return okRes<Member>({
      id: created.id,
      name: input.name,
      email,
      phone: null,
      role: input.role,
      status: "invited",
      teamIds: input.teamIds,
      twoFactorEnabled: false,
      invitedAt: new Date(created.createdAt).toISOString(),
      lastActiveAt: null,
    });
  });
}

async function orgName(db: Database, organizationId: string) {
  const [row] = await db.select({ name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, organizationId));
  return row?.name ?? brand.name;
}

async function sendInviteMail(
  deps: Deps,
  info: { id: string; email: string; name: string; organizationName: string; inviterName: string },
) {
  const link = `${deps.env.WEB_URL}/convite/${makeInviteToken(deps.env.BETTER_AUTH_SECRET, info.id)}`;
  await mailerFor(deps.env)({
    to: info.email,
    subject: `${info.inviterName} convidou você para o ${info.organizationName} no ${brand.name}`,
    text: `Oi, ${info.name}!\n\n${info.inviterName} convidou você para atender pela empresa ${info.organizationName} no ${brand.name}.\n\nPara aceitar, abra o link abaixo (vale por 48 horas):\n${link}\n\nSe você não esperava este convite, ignore este e-mail.`,
  });
}

export async function resendInvite(ctx: Ctx, invitationId: string): Promise<Res<null>> {
  const { deps, actor } = ctx;
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<null>> => {
    const invite = await findInvite(tx, actor.organizationId, invitationId);
    if (!invite) return errRes(404, "not_found", "Pessoa não encontrada.");
    if (invite.status === "accepted") return errRes(409, "invalid_state", "Esta pessoa já aceitou o convite.");
    if (invite.status !== "pending") return errRes(409, "invalid_state", "Este convite não está mais pendente. Convide a pessoa de novo.");
    if (!canManageMember(actor.role, invite)) return errRes(403, "forbidden", "Só o proprietário pode reenviar este convite.");

    await deps.auth.api.createInvitation({
      headers: ctx.headers,
      body: { email: invite.email, role: toBetterAuthRole(invite.role), organizationId: actor.organizationId, resend: true },
    });
    const [profile] = await tx
      .select({ name: schema.inviteProfiles.name })
      .from(schema.inviteProfiles)
      .where(and(eq(schema.inviteProfiles.organizationId, actor.organizationId), eq(schema.inviteProfiles.invitationId, invite.id)));
    await sendInviteMail(deps, {
      id: invite.id,
      email: invite.email,
      name: profile?.name ?? invite.email,
      organizationName: await orgName(deps.db, actor.organizationId),
      inviterName: actor.name,
    });
    return okRes(null);
  });
}

export async function cancelInvite(ctx: Ctx, invitationId: string): Promise<Res<null>> {
  const { deps, actor } = ctx;
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<null>> => {
    const invite = await findInvite(tx, actor.organizationId, invitationId);
    if (!invite) return errRes(404, "not_found", "Pessoa não encontrada.");
    if (invite.status !== "pending") return errRes(409, "invalid_state", "Esta pessoa já aceitou o convite.");
    if (!canManageMember(actor.role, invite)) return errRes(403, "forbidden", "Só o proprietário pode cancelar este convite.");

    await deps.auth.api.cancelInvitation({ headers: ctx.headers, body: { invitationId: invite.id } });
    await tx
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.organizationId, actor.organizationId), eq(schema.teamMembers.memberRef, invite.id)));
    await tx
      .delete(schema.inviteProfiles)
      .where(and(eq(schema.inviteProfiles.organizationId, actor.organizationId), eq(schema.inviteProfiles.invitationId, invite.id)));
    return okRes(null);
  });
}

// ---------- Pessoas ----------

export async function updateMember(ctx: Ctx, id: string, input: UpdateMemberInput): Promise<Res<Member>> {
  const { deps, actor } = ctx;
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<Member>> => {
    const org = actor.organizationId;
    await lockOrg(tx, org);
    const teamCheck = await assertTeamsExist(tx, org, input.teamIds);
    if (!teamCheck.ok) return teamCheck;

    const member = await findMemberRow(tx, org, id);
    if (member) {
      const isSelf = member.userId === actor.userId;
      if (!isSelf && !canManageMember(actor.role, member)) {
        return errRes(403, "forbidden", "Só o proprietário pode editar proprietários e administradores.");
      }
      if (member.role !== input.role) {
        const all = await listMemberRows(tx, org);
        const violation = checkRoleChange({
          actor: actor.role,
          target: { id: member.userId, role: member.role },
          newRole: input.role,
          activeOwnerCount: all.filter((m) => m.role === "owner" && m.active).length,
        });
        if (violation) return errRes(violation.code === "forbidden" ? 403 : 409, violation.code, violation.message);
        await tx
          .update(schema.member)
          .set({ role: toBetterAuthRole(input.role) })
          .where(and(eq(schema.member.organizationId, org), eq(schema.member.userId, member.userId)));
      }
      if (member.name !== input.name) await tx.update(schema.user).set({ name: input.name }).where(eq(schema.user.id, member.userId));
      await setMemberTeams(tx, org, member.userId, input.teamIds);
      const refreshed = await findMemberRow(tx, org, member.userId);
      return okRes(toMember(refreshed ?? member, input.name, input.teamIds));
    }

    // convite pendente
    const invite = await findInvite(tx, org, id);
    if (!invite || invite.status !== "pending") return errRes(404, "not_found", "Pessoa não encontrada.");
    if (!canManageMember(actor.role, invite)) return errRes(403, "forbidden", "Só o proprietário pode editar este convite.");
    if (invite.role !== input.role && !canAssignRole(actor.role, input.role)) {
      return errRes(403, "forbidden", "Só o proprietário pode promover a proprietário.");
    }
    await tx
      .update(schema.invitation)
      .set({ role: toBetterAuthRole(input.role) })
      .where(and(eq(schema.invitation.organizationId, org), eq(schema.invitation.id, invite.id)));
    await tx
      .insert(schema.inviteProfiles)
      .values({ invitationId: invite.id, organizationId: org, name: input.name })
      .onConflictDoUpdate({ target: schema.inviteProfiles.invitationId, set: { name: input.name } });
    await setMemberTeams(tx, org, invite.id, input.teamIds);
    return okRes<Member>({
      id: invite.id,
      name: input.name,
      email: invite.email,
      phone: null,
      role: input.role,
      status: "invited",
      teamIds: input.teamIds,
      twoFactorEnabled: false,
      invitedAt: null,
      lastActiveAt: null,
    });
  });
}

function toMember(row: Awaited<ReturnType<typeof findMemberRow>> & object, name: string, teamIds: string[]): Member {
  return {
    id: row.userId,
    name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.active ? "active" : "inactive",
    teamIds,
    twoFactorEnabled: row.twoFactorEnabled,
    invitedAt: null,
    lastActiveAt: null,
  };
}

/** Manda o e-mail de redefinição de senha. Ninguém define a senha de outra pessoa. */
export async function resetMemberPassword(ctx: Ctx, id: string): Promise<Res<{ email: string }>> {
  const { deps, actor } = ctx;
  const member = await withOrg(deps.db, actor.organizationId, (tx) => findMemberRow(tx, actor.organizationId, id));
  if (!member) return errRes(404, "not_found", "Pessoa não encontrada.");
  if (!member.active) return errRes(409, "invalid_state", "Só é possível redefinir a senha de quem está ativo.");
  if (member.userId !== actor.userId && !canManageMember(actor.role, member)) {
    return errRes(403, "forbidden", "Só o proprietário pode redefinir a senha de proprietários e administradores.");
  }
  await deps.auth.api.requestPasswordReset({
    body: { email: member.email, redirectTo: `${deps.env.WEB_URL}/redefinir-senha` },
  });
  return okRes({ email: member.email });
}

export async function setMemberActive(ctx: Ctx, id: string, active: boolean): Promise<Res<null>> {
  const { deps, actor } = ctx;
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<null>> => {
    const org = actor.organizationId;
    await lockOrg(tx, org);
    const members = await listMemberRows(tx, org);
    const member = members.find((m) => m.userId === id);
    if (!member) {
      const invite = await findInvite(tx, org, id);
      if (invite) return errRes(409, "invalid_state", active ? "Esta pessoa já está ativa." : "Esta pessoa não está ativa.");
      return errRes(404, "not_found", "Pessoa não encontrada.");
    }
    const target = { id: member.userId, role: member.role };

    if (active) {
      const violation = checkReactivate({ actor: actor.role, actorId: actor.userId, target });
      if (violation) return errRes(violation.code === "forbidden" ? 403 : 409, violation.code, violation.message);
      if (member.active) return errRes(409, "invalid_state", "Esta pessoa já está ativa.");
      const maxUsers = await maxUsersForPlan(tx, org);
      if (isOverUserLimit(await countUsers(tx, org), maxUsers)) return errRes(403, "plan_limit", limitMessage(maxUsers ?? 0));
      await upsertProfile(tx, org, member.userId, uuidv7(), { active: true, deactivatedAt: null });
      return okRes(null);
    }

    const violation = checkDeactivate({
      actor: actor.role,
      actorId: actor.userId,
      target,
      activeOwnerCount: members.filter((m) => m.role === "owner" && m.active).length,
    });
    if (violation) return errRes(violation.code === "forbidden" ? 403 : 409, violation.code, violation.message);
    if (!member.active) return errRes(409, "invalid_state", "Esta pessoa não está ativa.");

    await upsertProfile(tx, org, member.userId, uuidv7(), { active: false, deactivatedAt: new Date() });
    // derruba o acesso agora: sessões dessa empresa (ou sem empresa ativa) da pessoa
    await tx
      .delete(schema.session)
      .where(
        and(
          eq(schema.session.userId, member.userId),
          sql`(${schema.session.activeOrganizationId} = ${org} or ${schema.session.activeOrganizationId} is null)`,
        ),
      );
    return okRes(null);
  });
}

// ---------- Equipes ----------

async function assertTeamsExist(tx: Transaction, organizationId: string, teamIds: string[]): Promise<Res<null>> {
  if (teamIds.length === 0) return okRes(null);
  const unique = [...new Set(teamIds)];
  if (!unique.every(isUuid)) return errRes(422, "invalid_teams", "Equipe inválida.");
  const rows = await tx
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(and(eq(schema.teams.organizationId, organizationId), inArray(schema.teams.id, unique)));
  return rows.length === unique.length ? okRes(null) : errRes(422, "invalid_teams", "Equipe inválida.");
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Troca as equipes de UMA pessoa (ou convite). */
async function setMemberTeams(tx: Transaction, organizationId: string, ref: string, teamIds: string[]) {
  await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.organizationId, organizationId), eq(schema.teamMembers.memberRef, ref)));
  const unique = [...new Set(teamIds)];
  if (unique.length) {
    await tx.insert(schema.teamMembers).values(unique.map((teamId) => ({ teamId, organizationId, memberRef: ref })));
  }
}

async function assertMemberRefs(tx: Transaction, organizationId: string, refs: string[]): Promise<Res<null>> {
  const unique = [...new Set(refs)];
  if (unique.length === 0) return okRes(null);
  const members = await listMemberRows(tx, organizationId);
  const invites = await listPendingInvites(tx, organizationId);
  const known = new Set([...members.map((m) => m.userId), ...invites.map((i) => i.id)]);
  return unique.every((r) => known.has(r)) ? okRes(null) : errRes(422, "invalid_members", "Há pessoas que não pertencem à empresa.");
}

async function nameTaken(tx: Transaction, organizationId: string, name: string, exceptId?: string) {
  const rows = await tx
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(
      and(
        eq(schema.teams.organizationId, organizationId),
        sql`lower(${schema.teams.name}) = lower(${name})`,
        exceptId ? ne(schema.teams.id, exceptId) : undefined,
      ),
    );
  return rows.length > 0;
}

export async function createTeam(ctx: Omit<Ctx, "headers">, input: TeamInput): Promise<Res<Team>> {
  const { deps, actor } = ctx;
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<Team>> => {
    const org = actor.organizationId;
    if (await nameTaken(tx, org, input.name)) return errRes(409, "duplicate_name", "Já existe uma equipe com esse nome.");
    const refs = await assertMemberRefs(tx, org, input.memberIds);
    if (!refs.ok) return refs;
    const id = uuidv7();
    await tx.insert(schema.teams).values({
      id,
      organizationId: org,
      name: input.name,
      color: input.color,
      priority: input.priority,
      businessHours: input.businessHours,
      greeting: input.greeting,
      outOfHoursMessage: input.outOfHoursMessage,
    });
    await replaceTeamMembers(tx, org, id, input.memberIds);
    const linked = await writeTeamLinks(tx, org, id, input, true);
    if (!linked.ok) return linked;
    return okRes<Team>({
      ...input,
      id,
      greeting: input.greeting ?? "",
      outOfHoursMessage: input.outOfHoursMessage ?? "",
      memberIds: [...new Set(input.memberIds)],
      channelIds: [...new Set(input.channelIds)],
    });
  });
}

export async function updateTeam(ctx: Omit<Ctx, "headers">, id: string, input: TeamInput): Promise<Res<Team>> {
  const { deps, actor } = ctx;
  if (!isUuid(id)) return errRes(404, "not_found", "Equipe não encontrada.");
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<Team>> => {
    const org = actor.organizationId;
    const [existing] = await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(and(eq(schema.teams.organizationId, org), eq(schema.teams.id, id)));
    if (!existing) return errRes(404, "not_found", "Equipe não encontrada.");
    if (await nameTaken(tx, org, input.name, id)) return errRes(409, "duplicate_name", "Já existe uma equipe com esse nome.");
    const refs = await assertMemberRefs(tx, org, input.memberIds);
    if (!refs.ok) return refs;
    // greeting/outOfHoursMessage ausentes (undefined) não entram no UPDATE: o valor guardado é mantido
    const [saved] = await tx
      .update(schema.teams)
      .set({
        name: input.name,
        color: input.color,
        priority: input.priority,
        businessHours: input.businessHours,
        greeting: input.greeting,
        outOfHoursMessage: input.outOfHoursMessage,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.teams.organizationId, org), eq(schema.teams.id, id)))
      .returning({ greeting: schema.teams.greeting, outOfHoursMessage: schema.teams.outOfHoursMessage });
    await replaceTeamMembers(tx, org, id, input.memberIds);
    const linked = await writeTeamLinks(tx, org, id, input, false);
    if (!linked.ok) return linked;
    return okRes<Team>({
      ...input,
      id,
      greeting: saved?.greeting ?? "",
      outOfHoursMessage: saved?.outOfHoursMessage ?? "",
      memberIds: [...new Set(input.memberIds)],
      channelIds: [...new Set(input.channelIds)],
    });
  });
}

/**
 * Grava canais e agente da equipe em `channels.team_id`/`channels.agent_id`, na MESMA transação do restante.
 * Valida que canais e agente existem e são desta empresa (id de outra empresa = 422). O agente da equipe é o dos
 * canais dela: só é regravado quando muda em relação ao que já valia (senão salvar a equipe apagaria agentes
 * escolhidos canal a canal na tela de Canais).
 */
async function writeTeamLinks(tx: Transaction, org: string, teamId: string, input: TeamInput, creating: boolean): Promise<Res<null>> {
  const channels = await setTeamChannels(tx, org, teamId, input.channelIds);
  if (!channels.ok) return errRes(422, "invalid_channels", "Há canais que não pertencem à empresa.");
  const current = creating ? null : ((await agentIdByTeam(tx, org)).get(teamId) ?? null);
  if (input.agentId !== current) {
    const agent = await setTeamAgent(tx, org, teamId, input.agentId);
    if (!agent.ok) return errRes(422, "invalid_agent", "Agente não encontrado.");
  }
  return okRes(null);
}

async function replaceTeamMembers(tx: Transaction, organizationId: string, teamId: string, refs: string[]) {
  await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.organizationId, organizationId), eq(schema.teamMembers.teamId, teamId)));
  const unique = [...new Set(refs)];
  if (unique.length) {
    await tx.insert(schema.teamMembers).values(unique.map((memberRef) => ({ teamId, organizationId, memberRef })));
  }
}

export async function deleteTeam(ctx: Omit<Ctx, "headers">, id: string): Promise<Res<null>> {
  const { deps, actor } = ctx;
  if (!isUuid(id)) return errRes(404, "not_found", "Equipe não encontrada.");
  return withOrg(deps.db, actor.organizationId, async (tx): Promise<Res<null>> => {
    const org = actor.organizationId;
    const rows = await tx.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.organizationId, org));
    if (!rows.some((r) => r.id === id)) return errRes(404, "not_found", "Equipe não encontrada.");
    if (rows.length <= 1) return errRes(409, "last_team", "Mantenha pelo menos uma equipe para receber as conversas.");
    await tx.delete(schema.teams).where(and(eq(schema.teams.organizationId, org), eq(schema.teams.id, id)));
    return okRes(null);
  });
}
