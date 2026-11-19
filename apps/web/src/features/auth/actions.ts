"use server";

import { signInSchema, type SignInInput } from "@duckzap/contracts/auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { TwoFactorMethod } from "@duckzap/contracts/settings";
import { requestPasswordReset, sendTwoFactorEmailCode, signIn, signOut, verifyTwoFactorCode } from "./api";

/** `null` = entrou; `twoFactor` = senha ok, falta o código (do app ou do e-mail); `error` = mensagem para a tela. */
export type SignInState = { error: string } | { twoFactor: TwoFactorMethod } | null;

export async function signInAction(input: SignInInput): Promise<SignInState> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) return { error: "Confira o e-mail e a senha." };

  const result = await signIn(parsed.data);
  if (!result.ok) return { error: result.message };
  return result.data.twoFactor ? { twoFactor: result.data.twoFactor } : null;
}

const twoFactorSchema = z.object({
  code: z.string().trim().min(6, { error: "Digite o código." }).max(32),
  recovery: z.boolean().default(false),
  trustDevice: z.boolean().default(false),
  method: z.enum(["app", "email"]).default("app"),
});

export async function verifyTwoFactorAction(input: unknown): Promise<{ error: string; restart: boolean } | null> {
  const parsed = twoFactorSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Digite o código.", restart: false };
  const result = await verifyTwoFactorCode(parsed.data.code.replace(/\s+/g, ""), parsed.data);
  if (!result.ok) return { error: result.message, restart: result.error === "expired" };
  return null;
}

/** Login com código por e-mail: envia (ou reenvia) o código. `restart` = o desafio venceu; `useApp` = a conta usa o app. */
export async function sendTwoFactorEmailAction(): Promise<{ error: string; restart: boolean; useApp: boolean } | null> {
  const result = await sendTwoFactorEmailCode();
  if (!result.ok) return { error: result.message, restart: result.error === "expired", useApp: result.error === "use_app" };
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
