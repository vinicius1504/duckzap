import "server-only";
import { adminSessionSchema, type AdminSession, type AdminSignInInput } from "@duckzap/contracts/admin";
import { z } from "zod";
import { ApiUnavailableError, apiFetch, forwardSetCookies, readError } from "@/lib/api-server";
import { fail, ok, type Result } from "@/lib/result";

// Ligado ao back: /v1/admin/auth/* (senha → desafio → código TOTP; 2FA obrigatório). A sessão vive no banco
// e o navegador só guarda o cookie `dz_admin` (httpOnly, SameSite=Strict) que a API define no passo do código.
// O back também registra login, falha de login e saída em audit_logs (§5.1) e aplica rate limit por IP e por conta.

const UNAVAILABLE = "Não conseguimos falar com o servidor. Tente de novo em instantes.";

const startSchema = z.object({
  challengeToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  needsEnrollment: z.boolean(),
});

const challengeSchema = z.object({
  email: z.email(),
  /** só no primeiro login: chave para cadastrar no app autenticador */
  enrollment: z.object({ secret: z.string().min(1), otpauthUri: z.string().min(1) }).nullable(),
});
export type PendingChallenge = z.infer<typeof challengeSchema>;

/** 1º passo: e-mail e senha. Devolve um desafio de 2FA (nunca a sessão direto). */
export async function startSignIn(
  input: AdminSignInInput,
): Promise<
  Result<
    { challengeToken: string; expiresAt: string; needsEnrollment: boolean },
    "invalid_credentials" | "rate_limited" | "activation_required" | "unavailable"
  >
> {
  let response: Response;
  try {
    response = await apiFetch("/v1/admin/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        ...(input.activationCode ? { activationCode: input.activationCode } : {}),
      }),
    });
  } catch {
    return fail("unavailable", UNAVAILABLE);
  }
  if (!response.ok) {
    const error = await readError(response);
    if (response.status === 429) return fail("rate_limited", error.message);
    if (response.status === 401) {
      // 1º acesso: o servidor pede o código de ativação (gerado por script). Não é senha errada.
      if (error.code === "activation_required") return fail("activation_required", error.message);
      return fail("invalid_credentials", error.message);
    }
    return fail("unavailable", UNAVAILABLE);
  }
  const parsed = startSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? ok(parsed.data) : fail("unavailable", UNAVAILABLE);
}

/** Desafio de 2FA ainda válido (para retomar o passo do código; no 1º login traz a chave a cadastrar). */
export async function getChallenge(token: string): Promise<PendingChallenge | null> {
  const response = await apiFetch("/v1/admin/auth/challenge", { extraHeaders: { "x-admin-challenge": token } }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = challengeSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** 2º passo: código do app autenticador. Em caso de sucesso a API já devolve o cookie `dz_admin`. */
export async function verifyTwoFactor(
  challengeToken: string,
  code: string,
): Promise<Result<{ expiresAt: string }, "invalid_code" | "expired" | "too_many_attempts" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch("/v1/admin/auth/verify", { method: "POST", body: JSON.stringify({ challengeToken, code }) });
  } catch {
    return fail("unavailable", UNAVAILABLE);
  }
  if (!response.ok) {
    const error = await readError(response);
    if (error.code === "invalid_code") return fail("invalid_code", error.message);
    if (error.code === "too_many_attempts" || error.code === "rate_limited") return fail("too_many_attempts", error.message);
    if (error.code === "expired") return fail("expired", error.message);
    return fail("unavailable", UNAVAILABLE);
  }
  const parsed = adminSessionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return fail("unavailable", UNAVAILABLE);
  await forwardSetCookies(response);
  return ok({ expiresAt: parsed.data.expiresAt });
}

/** Sessão do cookie atual (null se não há, expirou ou foi revogada). */
export async function getCurrentSession(): Promise<AdminSession | null> {
  let response: Response;
  try {
    response = await apiFetch("/v1/admin/auth/session");
  } catch {
    // API fora do ar não é "deslogado": a tela de erro oferece tentar de novo
    throw new ApiUnavailableError();
  }
  if (response.status >= 500) throw new ApiUnavailableError(`API respondeu ${response.status}`);
  if (!response.ok) return null;
  const parsed = adminSessionSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ApiUnavailableError("Resposta inesperada da sessão");
  return parsed.data;
}

/** Saída: a API revoga a sessão no banco e limpa o cookie. */
export async function signOut(): Promise<void> {
  const response = await apiFetch("/v1/admin/auth/sign-out", { method: "POST", body: "{}" }).catch(() => null);
  if (response) await forwardSetCookies(response);
}
