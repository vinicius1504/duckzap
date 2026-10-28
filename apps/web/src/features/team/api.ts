import "server-only";
import {
  memberSchema,
  teamOverviewSchema,
  teamSchema,
  type InviteMemberInput,
  type Member,
  type Team,
  type TeamInput,
  type TeamOverview,
  type UpdateMemberInput,
} from "@duckzap/contracts/team";
import { z } from "zod";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/team): /v1/team/*. As regras de papel (só o proprietário cria
// proprietários, último proprietário protegido, ninguém se inativa) são aplicadas no servidor.
// Canais e agentes da equipe vêm da própria API de Equipe, derivados de `channels.team_id`/`channels.agent_id`
// (única fonte de verdade); a gravação do vínculo acontece no servidor, na mesma transação.

type MemberError = "not_found" | "forbidden" | "last_owner" | "plan_limit" | "duplicate_email" | "invalid_state" | "self";
const memberErrors = ["not_found", "forbidden", "last_owner", "plan_limit", "duplicate_email", "invalid_state", "self"] as const satisfies readonly MemberError[];

type TeamError = "not_found" | "duplicate_name" | "last_team" | "invalid_members" | "invalid_channels" | "invalid_agent";
const teamErrors = ["not_found", "duplicate_name", "last_team", "invalid_members", "invalid_channels", "invalid_agent"] as const satisfies readonly TeamError[];

export async function getTeamOverview(): Promise<TeamOverview> {
  return readApi("/v1/team/overview", teamOverviewSchema);
}

export async function inviteMember(input: InviteMemberInput): Promise<Result<Member, MemberError>> {
  return callApi("/v1/team/invites", memberSchema, { method: "POST", body: input, errors: memberErrors, fallback: "invalid_state" });
}

export async function resendInvite(id: string): Promise<Result<null, MemberError>> {
  return callApiVoid(`/v1/team/invites/${encodeURIComponent(id)}/resend`, { method: "POST", errors: memberErrors, fallback: "invalid_state" });
}

export async function cancelInvite(id: string): Promise<Result<null, MemberError>> {
  return callApiVoid(`/v1/team/invites/${encodeURIComponent(id)}`, { method: "DELETE", errors: memberErrors, fallback: "invalid_state" });
}

export async function updateMember(id: string, input: UpdateMemberInput): Promise<Result<Member, MemberError>> {
  return callApi(`/v1/team/members/${encodeURIComponent(id)}`, memberSchema, {
    method: "PATCH",
    body: input,
    errors: memberErrors,
    fallback: "invalid_state",
  });
}

/** Envia o e-mail de redefinição. A senha nunca é definida por outra pessoa. */
export async function resetMemberPassword(id: string): Promise<Result<{ email: string }, MemberError>> {
  return callApi(`/v1/team/members/${encodeURIComponent(id)}/password-reset`, z.object({ email: z.string() }), {
    method: "POST",
    errors: memberErrors,
    fallback: "invalid_state",
  });
}

export async function setMemberActive(id: string, active: boolean): Promise<Result<null, MemberError>> {
  return callApiVoid(`/v1/team/members/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`, {
    method: "POST",
    errors: memberErrors,
    fallback: "invalid_state",
  });
}

// ---------- Equipes ----------

export async function createTeam(input: TeamInput): Promise<Result<Team, TeamError>> {
  return callApi("/v1/team/teams", teamSchema, { method: "POST", body: input, errors: teamErrors, fallback: "invalid_members" });
}

export async function updateTeam(id: string, input: TeamInput): Promise<Result<Team, TeamError>> {
  return callApi(`/v1/team/teams/${encodeURIComponent(id)}`, teamSchema, {
    method: "PATCH",
    body: input,
    errors: teamErrors,
    fallback: "invalid_members",
  });
}

export async function deleteTeam(id: string): Promise<Result<null, TeamError>> {
  // apagar a equipe solta os canais dela no banco (FK ON DELETE SET NULL)
  return callApiVoid(`/v1/team/teams/${encodeURIComponent(id)}`, {
    method: "DELETE",
    errors: teamErrors,
    fallback: "not_found",
  });
}
