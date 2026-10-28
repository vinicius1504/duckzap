import { isAccountSuspended, sessionSchema } from "@duckzap/contracts/session";

/** Resultado de validar a sessão do navegador contra a API. */
export type SessionCheck =
  | { kind: "ok"; organizationId: string; userId: string }
  | { kind: "unauthorized" }
  | { kind: "suspended" }
  /** API fora do ar, lenta ou respondendo algo inesperado: o cliente tenta de novo (503). Não derruba conexões já abertas. */
  | { kind: "unavailable" };

/** Recebe o cabeçalho `Cookie` do navegador e diz quem é a pessoa. Única fonte de empresa/usuário do servidor. */
export type ValidateSession = (cookie: string) => Promise<SessionCheck>;

export interface ApiSessionValidatorOptions {
  /** Ex.: http://127.0.0.1:4000 */
  apiUrl: string;
  /** Origem enviada à API (a primeira de WEB_ORIGINS), como o navegador do front faria. */
  origin: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Valida a sessão chamando `GET /v1/me` da API com o cookie do navegador repassado.
 * 200 → lê a empresa e a pessoa; 401/403 → sem sessão/sem empresa; empresa suspensa → `suspended`; o resto → `unavailable`.
 */
export function createApiSessionValidator(options: ApiSessionValidatorOptions): ValidateSession {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.apiUrl.replace(/\/+$/, "")}/v1/me`;
  return async (cookie) => {
    if (!cookie.trim()) return { kind: "unauthorized" };
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { cookie, origin: options.origin, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      return { kind: "unavailable" };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "unauthorized" };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "unavailable" };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unavailable" };
    }
    const session = sessionSchema.safeParse(body);
    if (!session.success) return { kind: "unavailable" };
    if (isAccountSuspended(session.data.organization.subscriptionStatus)) return { kind: "suspended" };
    return { kind: "ok", organizationId: session.data.organization.id, userId: session.data.user.id };
  };
}
