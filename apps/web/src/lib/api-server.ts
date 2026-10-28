import "server-only";
import { cookies, headers as requestHeaders } from "next/headers";

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
const webUrl = process.env.WEB_URL ?? "http://localhost:3000";

/** Cookies de sessão do Better Auth (prefixo "dz"; em produção o navegador usa `__Secure-`). */
export const SESSION_COOKIE_NAMES = ["dz.session_token", "__Secure-dz.session_token"] as const;

/**
 * Chamada servidor→API repassando os cookies do pedido atual (a sessão).
 * Devolve a Response crua: quem chama decide como tratar status e corpo.
 */
export async function apiFetch(path: string, init: RequestInit = {}) {
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join("; ");
  const headers = new Headers(init.headers);
  headers.set("cookie", cookieHeader);
  // a API confere a origem (trustedOrigins) nas rotas de autenticação
  headers.set("origin", webUrl);
  // atrás de um proxy confiável (Caddy/Cloudflare) o IP real do cliente vem em x-forwarded-for; a API só o usa com TRUST_PROXY=true
  const forwarded = (await requestHeaders()).get("x-forwarded-for");
  if (forwarded) headers.set("x-forwarded-for", forwarded);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${apiUrl}${path}`, { ...init, headers, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS) });
}

/** Repassa os Set-Cookie da API para o navegador (login, logout, renovação de sessão). */
export async function forwardSetCookies(response: Response) {
  const store = await cookies();
  for (const raw of response.headers.getSetCookie()) {
    const [pair = "", ...attrs] = raw.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1));
    const attr = (key: string) => attrs.find((a) => a.toLowerCase().startsWith(`${key}=`))?.split("=")[1];
    const maxAge = attr("max-age");
    store.set(name, value, {
      httpOnly: true,
      secure: attrs.some((a) => a.toLowerCase() === "secure"),
      sameSite: "lax",
      path: attr("path") ?? "/",
      ...(maxAge !== undefined ? { maxAge: Number(maxAge) } : {}),
    });
  }
}
