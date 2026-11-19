import "server-only";
import {
  recoveryCodesSchema,
  twoFactorEmailSetupSchema,
  twoFactorSetupSchema,
  type RecoveryCodes,
  type TwoFactorEmailSetup,
  type TwoFactorSetup,
} from "@duckzap/contracts/settings";
import { z } from "zod";
import { callApi, callApiVoid } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// Verificação em duas etapas da pessoa logada (Ajustes › Minha conta e o passo "Proteja sua conta" do cadastro).
// Só precisa da sessão (a API não exige empresa). O Better Auth troca a sessão ao ligar/desligar: os cookies novos são repassados.

/** App autenticador, passo 1 (exige a senha): QR Code e chave para digitar. */
export async function startAppSetup(password: string): Promise<Result<TwoFactorSetup, "wrong_password" | "already_enabled">> {
  return callApi("/v1/account/two-factor/setup", twoFactorSetupSchema, {
    method: "POST",
    body: { password },
    errors: ["wrong_password", "already_enabled"],
    fallback: "wrong_password",
    forwardCookies: true,
  });
}

/** App autenticador, passo 2: confere o código do app, liga o 2FA e devolve os códigos de recuperação (mostrados uma vez). */
export async function confirmAppSetup(code: string): Promise<Result<{ recoveryCodes: string[] }, "no_setup" | "invalid_code">> {
  return callApi("/v1/account/two-factor/confirm", z.object({ recoveryCodes: z.array(z.string()) }), {
    method: "POST",
    body: { code },
    errors: ["no_setup", "invalid_code"],
    fallback: "invalid_code",
    forwardCookies: true,
  });
}

/** Código por e-mail, passo 1 (exige a senha): envia o código para o e-mail da conta. */
export async function startEmailSetup(password: string): Promise<Result<TwoFactorEmailSetup, "wrong_password" | "rate_limited">> {
  return callApi("/v1/account/two-factor/email/setup", twoFactorEmailSetupSchema, {
    method: "POST",
    body: { password },
    errors: ["wrong_password", "rate_limited"],
    fallback: "wrong_password",
    forwardCookies: true,
  });
}

/** Código por e-mail, passo 2: confere o código e liga o 2FA. */
export async function confirmEmailSetup(code: string): Promise<Result<RecoveryCodes, "invalid_code" | "expired">> {
  return callApi("/v1/account/two-factor/email/confirm", recoveryCodesSchema, {
    method: "POST",
    body: { code },
    errors: ["invalid_code", "expired"],
    fallback: "invalid_code",
    forwardCookies: true,
  });
}

/** Novos códigos de recuperação (os antigos deixam de valer). */
export async function regenerateRecoveryCodes(password: string): Promise<Result<{ recoveryCodes: string[] }, "wrong_password">> {
  return callApi("/v1/account/two-factor/recovery-codes", z.object({ recoveryCodes: z.array(z.string()) }), {
    method: "POST",
    body: { password },
    errors: ["wrong_password"],
    fallback: "wrong_password",
    forwardCookies: true,
  });
}

export async function disableTwoFactor(password: string): Promise<Result<null, "required" | "wrong_password">> {
  return callApiVoid("/v1/account/two-factor/disable", {
    method: "POST",
    body: { password },
    errors: ["required", "wrong_password"],
    fallback: "wrong_password",
    forwardCookies: true,
  });
}

/** "Pular por enquanto" no cadastro (gravado na conta; dá para ativar depois em Ajustes). */
export async function skipSecurityStep(): Promise<Result<null, "unavailable">> {
  return callApiVoid("/v1/onboarding/security/skip", { method: "POST", body: {}, errors: [], fallback: "unavailable" });
}
