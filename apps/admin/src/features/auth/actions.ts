"use server";

import {
  adminSignInSchema,
  adminTwoFactorSchema,
  type AdminSignInInput,
} from "@duckzap/contracts/admin";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getChallenge, signOut, startSignIn, verifyTwoFactor } from "./api";
import { ADMIN_CHALLENGE_COOKIE, ADMIN_SESSION_COOKIE } from "./session";

const cookieBase = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/** `enrollment` só no primeiro login: chave TOTP a cadastrar no app autenticador (2FA é obrigatório). */
export type Enrollment = { secret: string; otpauthUri: string };
export type SignInStepResult =
  | { error: string; needsActivationCode?: boolean }
  | { step: "two_factor"; email: string; enrollment: Enrollment | null };

export async function startSignInAction(input: AdminSignInInput): Promise<SignInStepResult> {
  const parsed = adminSignInSchema.safeParse(input);
  if (!parsed.success) return { error: "Confira o e-mail e a senha." };

  const result = await startSignIn(parsed.data);
  if (!result.ok) return { error: result.message, needsActivationCode: result.error === "activation_required" };

  (await cookies()).set(ADMIN_CHALLENGE_COOKIE, result.data.challengeToken, {
    ...cookieBase,
    maxAge: 5 * 60,
  });
  const challenge = result.data.needsEnrollment ? await getChallenge(result.data.challengeToken) : null;
  return { step: "two_factor", email: parsed.data.email, enrollment: challenge?.enrollment ?? null };
}

export type VerifyResult = { error: string; restart: boolean } | null;

export async function verifyTwoFactorAction(code: string): Promise<VerifyResult> {
  const parsed = adminTwoFactorSchema.safeParse({ code });
  if (!parsed.success) return { error: "O código tem 6 números.", restart: false };

  const jar = await cookies();
  const challenge = jar.get(ADMIN_CHALLENGE_COOKIE)?.value;
  if (!challenge)
    return { error: "O tempo para digitar o código acabou. Entre de novo.", restart: true };

  const result = await verifyTwoFactor(challenge, parsed.data.code);
  if (!result.ok) {
    const restart = result.error !== "invalid_code";
    if (restart) jar.delete(ADMIN_CHALLENGE_COOKIE);
    return { error: result.message, restart };
  }

  // o cookie `dz_admin` (sessão de até 8 h, sem "manter conectado") já foi repassado pela API em verifyTwoFactor
  jar.delete(ADMIN_CHALLENGE_COOKIE);
  return null;
}

export async function cancelSignInAction() {
  (await cookies()).delete(ADMIN_CHALLENGE_COOKIE);
}

export async function signOutAction() {
  const jar = await cookies();
  if (jar.get(ADMIN_SESSION_COOKIE)?.value) await signOut();
  jar.delete(ADMIN_SESSION_COOKIE);
  redirect("/entrar");
}
