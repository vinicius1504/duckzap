"use server";

import type { RecoveryCodes, TwoFactorEmailSetup, TwoFactorSetup } from "@duckzap/contracts/settings";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Result } from "@/lib/mock";
import {
  confirmAppSetup,
  confirmEmailSetup,
  disableTwoFactor,
  regenerateRecoveryCodes,
  skipSecurityStep,
  startAppSetup,
  startEmailSetup,
} from "./api";
import { normalizeCode } from "./rules";

// Server Actions finas do 2FA: validação → api.ts → revalidar. Quem é a pessoa vem da SESSÃO (a API recusa sem sessão
// e o api-call manda para o login). Servem a Ajustes › Minha conta e ao cadastro (/comecar), que ainda não tem empresa.

export type ActionResult<T> = { ok: true; data: T } | { ok?: false; error: string };

/** Telas que mostram o estado do 2FA (o cadastro, Minha conta, o checklist da Início e a Equipe). */
const SCREENS = ["/comecar", "/ajustes", "/inicio", "/equipe"];

function done<T>(result: Result<T>): ActionResult<T> {
  if (!result.ok) return { ok: false, error: result.message };
  for (const path of SCREENS) revalidatePath(path);
  return result;
}

const passwordSchema = z.string().min(1, "Informe sua senha.").max(128);
const codeSchema = z.string().regex(/^\d{6}$/, "O código tem 6 números.");

function first(error: z.ZodError): ActionResult<never> {
  return { ok: false, error: error.issues[0]?.message ?? "Confira os campos." };
}

export async function startAppSetupAction(password: string): Promise<ActionResult<TwoFactorSetup>> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return first(parsed.error);
  const result = await startAppSetup(parsed.data);
  return result.ok ? result : { ok: false, error: result.message };
}

export async function confirmAppSetupAction(code: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const parsed = codeSchema.safeParse(normalizeCode(code));
  if (!parsed.success) return first(parsed.error);
  return done(await confirmAppSetup(parsed.data));
}

export async function startEmailSetupAction(password: string): Promise<ActionResult<TwoFactorEmailSetup>> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return first(parsed.error);
  const result = await startEmailSetup(parsed.data);
  return result.ok ? result : { ok: false, error: result.message };
}

export async function confirmEmailSetupAction(code: string): Promise<ActionResult<RecoveryCodes>> {
  const parsed = codeSchema.safeParse(normalizeCode(code));
  if (!parsed.success) return first(parsed.error);
  return done(await confirmEmailSetup(parsed.data));
}

export async function regenerateRecoveryCodesAction(password: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return first(parsed.error);
  return done(await regenerateRecoveryCodes(parsed.data));
}

export async function disableTwoFactorAction(password: string): Promise<ActionResult<null>> {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return first(parsed.error);
  return done(await disableTwoFactor(parsed.data));
}

export async function skipSecurityStepAction(): Promise<ActionResult<null>> {
  return done(await skipSecurityStep());
}
