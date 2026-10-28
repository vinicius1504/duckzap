"use server";

import { inviteMemberInputSchema, teamInputSchema, updateMemberInputSchema, type Member, type Team } from "@duckzap/contracts/team";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import type { Result } from "@/lib/mock";
import {
  cancelInvite,
  createTeam,
  deleteTeam,
  inviteMember,
  resendInvite,
  resetMemberPassword,
  setMemberActive,
  updateMember,
  updateTeam,
} from "./api";

// Server Actions finas: permissão → validação → api.ts → revalidar. Regras de papel ficam na api (e no back).

export type ActionResult<T> = { ok: true; data: T } | { ok?: false; error: string };

const idSchema = z.string().min(1).max(64);

function done<T>(result: Result<T>): ActionResult<T> {
  if (!result.ok) return { ok: false, error: result.message };
  revalidatePath("/equipe");
  revalidatePath("/canais");
  return result;
}

function invalid(error: z.ZodError): ActionResult<never> {
  return { ok: false, error: error.issues[0]?.message ?? "Confira os campos." };
}

export async function inviteMemberAction(input: unknown): Promise<ActionResult<Member>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  const parsed = inviteMemberInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await inviteMember(parsed.data));
}

export async function resendInviteAction(id: string): Promise<ActionResult<null>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  return done(await resendInvite(idSchema.parse(id)));
}

export async function cancelInviteAction(id: string): Promise<ActionResult<null>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  return done(await cancelInvite(idSchema.parse(id)));
}

export async function updateMemberAction(id: string, input: unknown): Promise<ActionResult<Member>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  const parsed = updateMemberInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await updateMember(idSchema.parse(id), parsed.data));
}

export async function resetPasswordAction(id: string): Promise<ActionResult<{ email: string }>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  return done(await resetMemberPassword(idSchema.parse(id)));
}

export async function setMemberActiveAction(id: string, active: boolean): Promise<ActionResult<null>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  return done(await setMemberActive(idSchema.parse(id), z.boolean().parse(active)));
}

export async function saveTeamAction(id: string | null, input: unknown): Promise<ActionResult<Team>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  const parsed = teamInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(id ? await updateTeam(idSchema.parse(id), parsed.data) : await createTeam(parsed.data));
}

export async function deleteTeamAction(id: string): Promise<ActionResult<null>> {
  const auth = await authorize("team.manage");
  if ("error" in auth) return auth;
  return done(await deleteTeam(idSchema.parse(id)));
}
