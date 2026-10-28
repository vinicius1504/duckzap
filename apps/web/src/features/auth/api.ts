import "server-only";
import type { SignInInput } from "@duckzap/contracts/auth";
import { sessionSchema, type Session } from "@duckzap/contracts/session";
import { ApiUnavailableError, apiFetch, forwardSetCookies } from "@/lib/api-server";
import { fail, ok, type Result } from "@/lib/mock";

// Ligado ao back (Better Auth em /v1/auth/* e sessão em /v1/me).

/** `twoFactor: true` = senha ok, falta o código do app autenticador (o cookie do desafio já foi repassado). */
export async function signIn(
  input: SignInInput,
): Promise<Result<{ twoFactor: boolean }, "invalid_credentials" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch("/v1/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: input.email, password: input.password, rememberMe: input.rememberMe }),
    });
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.status === 429) return fail("unavailable", "Muitas tentativas. Aguarde um minuto e tente de novo.");
  if (!response.ok) return fail("invalid_credentials", "E-mail ou senha incorretos. Confira e tente de novo.");

  const body = (await response.json().catch(() => null)) as { twoFactorRedirect?: boolean } | null;
  // com 2FA o Better Auth ainda não abriu a sessão: devolve o cookie do desafio, que vai junto no passo do código
  await forwardSetCookies(response);
  return ok({ twoFactor: Boolean(body?.twoFactorRedirect) });
}

/** 2º passo do login: código de 6 dígitos (ou código de recuperação) do app autenticador. */
export async function verifyTwoFactorCode(
  code: string,
  options: { recovery?: boolean; trustDevice?: boolean } = {},
): Promise<Result<null, "invalid_code" | "expired" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch(options.recovery ? "/v1/auth/two-factor/verify-backup-code" : "/v1/auth/two-factor/verify-totp", {
      method: "POST",
      body: JSON.stringify({ code, trustDevice: Boolean(options.trustDevice) }),
    });
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.status === 429) return fail("unavailable", "Muitas tentativas. Aguarde um minuto e tente de novo.");
  if (response.status === 401 || response.status === 400) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    // sem o cookie do desafio (expirou ou foi apagado) o código nem é conferido: recomeça do login
    if (typeof body?.code === "string" && /INVALID_TWO_FACTOR_COOKIE|TWO_FACTOR_COOKIE/.test(body.code)) {
      return fail("expired", "A verificação expirou. Entre com e-mail e senha de novo.");
    }
    return fail("invalid_code", "Código incorreto ou vencido. Confira o app autenticador e tente de novo.");
  }
  if (!response.ok) return fail("unavailable", "Não foi possível verificar o código. Tente de novo.");
  await forwardSetCookies(response);
  return ok(null);
}

/**
 * Sessão atual. `null` = deslogado (401/403/sem cookie). API fora do ar, lenta ou com 5xx NÃO é "deslogado":
 * lança `ApiUnavailableError` e a tela de erro oferece "Tentar de novo" (sem derrubar o usuário no login).
 */
export async function getCurrentSession(): Promise<Session | null> {
  let response: Response;
  try {
    response = await apiFetch("/v1/me");
  } catch {
    throw new ApiUnavailableError();
  }
  if (response.status >= 500) throw new ApiUnavailableError(`API respondeu ${response.status}`);
  if (!response.ok) return null;
  const parsed = sessionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiUnavailableError("Resposta inesperada de /v1/me");
  return parsed.data;
}

export async function signOut(): Promise<void> {
  const response = await apiFetch("/v1/auth/sign-out", { method: "POST", body: "{}" }).catch(() => null);
  if (response) await forwardSetCookies(response);
}

export async function requestPasswordReset(email: string): Promise<Result<null, never>> {
  await apiFetch("/v1/auth/request-password-reset", {
    method: "POST",
    body: JSON.stringify({ email, redirectTo: "/redefinir-senha" }),
  }).catch(() => null);
  // sempre "ok": não revela se o e-mail existe
  return ok(null);
}
