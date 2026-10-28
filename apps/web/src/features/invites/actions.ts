"use server";

import { signUpSchema } from "@duckzap/contracts/onboarding";
import { redirect } from "next/navigation";
import { acceptInvite, type AcceptError } from "./api";

export type AcceptInviteState = { error: string; code: AcceptError | "invalid_input" } | null;

/** Aceita o convite. Conta nova: precisa de senha. Conta existente: precisa estar logada com o e-mail do convite. */
export async function acceptInviteAction(token: string, password: string | null): Promise<AcceptInviteState> {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) {
    return { error: "Este convite não é válido.", code: "invalid_input" };
  }
  if (password !== null) {
    const parsed = signUpSchema.shape.password.safeParse(password);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Confira a senha.", code: "invalid_input" };
  }
  const result = await acceptInvite(token, password ?? undefined);
  if (!result.ok) return { error: result.message, code: result.error };
  redirect("/inicio");
}
