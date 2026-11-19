import "server-only";
import type { SignInInput } from "@duckzap/contracts/auth";
import { sessionSchema, type Session } from "@duckzap/contracts/session";
import { ApiUnavailableError, apiFetch, forwardSetCookies } from "@/lib/api-server";
import { fail, ok, type Result } from "@/lib/mock";
import type { TwoFactorMethod } from "@duckzap/contracts/settings";
import { signInMethod } from "@/features/security/rules";

// Ligado ao back (Better Auth em /v1/auth/* e sessão em /v1/me).

/**
 * `twoFactor` = senha ok, falta o código (o cookie do desafio já foi repassado): "app" = do app autenticador; "email" = a tela
 * pede o envio do código por e-mail (`sendTwoFactorEmailCode`). null = entrou.
 */
export async function signIn(
  input: SignInInput,
): Promise<Result<{ twoFactor: TwoFactorMethod | null }, "invalid_credentials" | "unavailable">> {
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

  const body = (await response.json().catch(() => null)) as { twoFactorRedirect?: boolean; twoFactorMethods?: unknown } | null;
  // com 2FA o Better Auth ainda não abriu a sessão: devolve o cookie do desafio, que vai junto no passo do código
  await forwardSetCookies(response);
  return ok({ twoFactor: body?.twoFactorRedirect ? signInMethod(body.twoFactorMethods) : null });
}

const isChallengeError = (code: unknown) => typeof code === "string" && /INVALID_TWO_FACTOR_COOKIE|TWO_FACTOR_COOKIE/.test(code);

/** Login com código por e-mail: manda o código para o e-mail da conta (o servidor limita os envios por pessoa). */
export async function sendTwoFactorEmailCode(): Promise<Result<null, "expired" | "use_app" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch("/v1/auth/two-factor/send-otp", { method: "POST", body: "{}" });
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.ok) return ok(null);
  const body = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  if (response.status === 429) {
    return fail("unavailable", typeof body?.message === "string" ? body.message : "Muitas tentativas. Aguarde um minuto e tente de novo.");
  }
  if (isChallengeError(body?.code)) return fail("expired", "A verificação expirou. Entre com e-mail e senha de novo.");
  if (body?.code === "USE_AUTHENTICATOR_APP") return fail("use_app", "Sua conta usa o app autenticador. Digite o código do app.");
  return fail("unavailable", "Não conseguimos enviar o código agora. Tente de novo.");
}

/** 2º passo do login: código de 6 dígitos do app autenticador ou do e-mail (ou um código de recuperação). */
export async function verifyTwoFactorCode(
  code: string,
  options: { recovery?: boolean; trustDevice?: boolean; method?: TwoFactorMethod } = {},
): Promise<Result<null, "invalid_code" | "expired" | "unavailable">> {
  const path = options.recovery
    ? "/v1/auth/two-factor/verify-backup-code"
    : options.method === "email"
      ? "/v1/auth/two-factor/verify-otp"
      : "/v1/auth/two-factor/verify-totp";
  let response: Response;
  try {
    response = await apiFetch(path, {
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
    if (isChallengeError(body?.code)) return fail("expired", "A verificação expirou. Entre com e-mail e senha de novo.");
    if (options.recovery) return fail("invalid_code", "Código de recuperação incorreto ou já usado. Confira e tente de novo.");
    if (options.method === "email") {
      if (body?.code === "OTP_HAS_EXPIRED" || body?.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
        return fail("invalid_code", "O código venceu ou teve tentativas demais. Clique em Reenviar código.");
      }
      return fail("invalid_code", "Código incorreto. Confira o e-mail e tente de novo.");
    }
    return fail("invalid_code", "Código incorreto ou vencido. Confira o app autenticador e tente de novo.");
  }
  if (!response.ok) return fail("unavailable", "Não foi possível verificar o código. Tente de novo.");
  await forwardSetCookies(response);
  return ok(null);
}

/** Resultado de `/v1/me`: sessão completa, deslogado, ou logado SEM empresa (criou a conta e parou no cadastro). */
export type SessionLookup = { kind: "ok"; session: Session } | { kind: "anonymous" } | { kind: "no_organization" };

/**
 * Sessão atual. 401/403/sem cookie = deslogado, salvo 403 `no_organization` (conta sem empresa: volta a /comecar).
 * API fora do ar, lenta ou com 5xx NÃO é "deslogado": lança `ApiUnavailableError` e a tela de erro oferece
 * "Tentar de novo" (sem derrubar o usuário no login).
 */
export async function lookupSession(): Promise<SessionLookup> {
  let response: Response;
  try {
    response = await apiFetch("/v1/me");
  } catch {
    throw new ApiUnavailableError();
  }
  if (response.status >= 500) throw new ApiUnavailableError(`API respondeu ${response.status}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    return response.status === 403 && body?.error?.code === "no_organization" ? { kind: "no_organization" } : { kind: "anonymous" };
  }
  const parsed = sessionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiUnavailableError("Resposta inesperada de /v1/me");
  return { kind: "ok", session: parsed.data };
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
