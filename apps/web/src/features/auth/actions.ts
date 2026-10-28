"use server";

import { signInSchema, type SignInInput } from "@duckzap/contracts/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requestPasswordReset, signIn, signOut, verifyTwoFactorCode } from "./api";

/** `null` = entrou; `twoFactor` = senha ok, falta o código; `error` = mensagem para a tela. */
export type SignInState = { error: string } | { twoFactor: true } | null;

export async function signInAction(input: SignInInput): Promise<SignInState> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) return { error: "Confira o e-mail e a senha." };

  const result = await signIn(parsed.data);
  if (!result.ok) return { error: result.message };
  return result.data.twoFactor ? { twoFactor: true } : null;
}

const twoFactorSchema = z.object({
  code: z.string().trim().min(6, { error: "Digite o código." }).max(32),
  recovery: z.boolean().default(false),
  trustDevice: z.boolean().default(false),
});

export async function verifyTwoFactorAction(input: unknown): Promise<{ error: string; restart: boolean } | null> {
  const parsed = twoFactorSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Digite o código.", restart: false };
  const result = await verifyTwoFactorCode(parsed.data.code.replace(/\s+/g, ""), parsed.data);
  if (!result.ok) return { error: result.message, restart: result.error === "expired" };
  return null;
}

export async function signOutAction() {
  await signOut();
  redirect("/entrar");
}

export async function requestPasswordResetAction(email: string): Promise<{ ok: true } | { error: string }> {
  const parsed = z.email().safeParse(email.trim().toLowerCase());
  if (!parsed.success) return { error: "Informe um e-mail válido." };
  await requestPasswordReset(parsed.data);
  return { ok: true };
}
