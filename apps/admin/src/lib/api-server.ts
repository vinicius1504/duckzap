import "server-only";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { fail, ok, type Result } from "@/lib/result";

const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
/** Tempo máximo de uma chamada servidor→API: sem isso uma API travada deixa a página pendurada. */
export const API_TIMEOUT_MS = 10_000;

/** API fora do ar, lenta ou respondendo 5xx. Diferente de "sessão inválida": a tela mostra "Serviço indisponível", não manda para o login. */
export class ApiUnavailableError extends Error {
  constructor(message = "API indisponível") {
    super(message);
    this.name = "ApiUnavailableError";
  }
}
/** Origem do painel: a API só aceita escritas vindas dela (defesa extra contra CSRF). */
const adminUrl = process.env.ADMIN_URL ?? "http://localhost:3002";

/** Cookie de sessão do painel (SameSite=Strict, httpOnly). Separado do `dz.session_token` das empresas. */
export const ADMIN_SESSION_COOKIE = "dz_admin";

/**
 * Chamada servidor→API repassando SÓ o cookie do painel (nunca cookies de outras aplicações) e o IP do cliente
 * (a API usa para allowlist/rate limit/auditoria quando ADMIN_TRUST_PROXY=true). Devolve a Response crua.
 */
export async function apiFetch(path: string, init: RequestInit & { extraHeaders?: Record<string, string> } = {}) {
  const { extraHeaders, ...rest } = init;
  const jar = await cookies();
  const reqHeaders = await headers();
  const out = new Headers(rest.headers);
  const session = jar.get(ADMIN_SESSION_COOKIE)?.value;
  if (session) out.set("cookie", `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(session)}`);
  out.set("origin", adminUrl);
  const forwarded = reqHeaders.get("x-forwarded-for");
  if (forwarded) out.set("x-forwarded-for", forwarded);
  for (const [key, value] of Object.entries(extraHeaders ?? {})) out.set(key, value);
  if (rest.body && !out.has("content-type")) out.set("content-type", "application/json");
  return fetch(`${apiUrl}${path}`, { ...rest, headers: out, cache: "no-store", signal: rest.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
}

/** Repassa o Set-Cookie do painel (login/logout) para o navegador, sempre httpOnly + SameSite=Strict. */
export async function forwardSetCookies(response: Response) {
  const store = await cookies();
  for (const raw of response.headers.getSetCookie()) {
    const [pair = "", ...attrs] = raw.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq);
    if (name !== ADMIN_SESSION_COOKIE) continue;
    const value = decodeURIComponent(pair.slice(eq + 1));
    const attr = (key: string) => attrs.find((a) => a.toLowerCase().startsWith(`${key}=`))?.split("=")[1];
    const maxAge = attr("max-age");
    if (maxAge === "0" || value === "") {
      store.delete(name);
      continue;
    }
    store.set(name, value, {
      httpOnly: true,
      secure: attrs.some((a) => a.toLowerCase() === "secure"),
      sameSite: "strict",
      path: attr("path") ?? "/",
      ...(maxAge !== undefined ? { maxAge: Number(maxAge) } : {}),
    });
  }
}

export type ApiErrorBody = { code: string; message: string };

export async function readError(response: Response): Promise<ApiErrorBody> {
  const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  return {
    code: typeof body?.error?.code === "string" ? body.error.code : "unknown",
    message: typeof body?.error?.message === "string" ? body.error.message : "Algo deu errado. Tente de novo.",
  };
}

/** Leitura validada pelo schema do contrato. Sessão inválida/expirada => volta para o login; outros erros => página de erro. */
export async function apiRead<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
  const response = await apiFetch(path);
  if (response.status === 401) redirect("/entrar");
  if (!response.ok) throw new Error(`API ${path} respondeu ${response.status}`);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error(`Resposta inesperada de ${path}`);
  return parsed.data;
}

/** Como `apiRead`, mas 404 vira `null` (ex.: empresa que não existe). */
export async function apiReadOrNull<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | null> {
  const response = await apiFetch(path);
  if (response.status === 404) return null;
  if (response.status === 401) redirect("/entrar");
  if (!response.ok) throw new Error(`API ${path} respondeu ${response.status}`);
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error(`Resposta inesperada de ${path}`);
  return parsed.data;
}

/**
 * Mutação com `Result` (mesmo formato do mock): erro conhecido da API => `{ ok:false, error, message }`;
 * sessão expirada => login; API fora do ar => `unavailable`.
 */
export async function apiCommand<S extends z.ZodType, E extends string>(
  path: string,
  init: { method: "POST" | "PATCH" | "DELETE"; body: unknown },
  schema: S,
  knownErrors: readonly E[],
  fallback: E,
): Promise<Result<z.infer<S>, E | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch(path, { method: init.method, body: JSON.stringify(init.body) });
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.status === 401) redirect("/entrar");
  if (!response.ok) {
    const error = await readError(response);
    const code = knownErrors.find((known) => known === error.code) ?? fallback;
    return fail(code, error.message);
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return fail("unavailable", "Resposta inesperada do servidor. Tente de novo.");
  return ok(parsed.data);
}

/** Schema de página (`Paginated<T>` do contrato) para validar listagens. */
export function paginatedOf<S extends z.ZodType>(item: S) {
  return z.object({
    items: z.array(item),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    pageCount: z.number().int().min(1),
  });
}
