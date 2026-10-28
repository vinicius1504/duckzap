import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, generateNonce } from "@/lib/csp";

// checagem otimista (só presença do cookie); a validação de verdade acontece no layout com a sessão.
// Cookie próprio do painel: a sessão das empresas (dz_session) não abre nada aqui.
const SESSION_COOKIE = "dz_admin";
const publicPaths = ["/entrar"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // CSP com nonce por requisição: o Next lê o nonce do header da requisição e o layout repassa ao <Script> do tema
  const nonce = generateNonce();
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development" });

  const isPublic = publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // tudo menos assets e arquivos públicos (o painel não expõe /api: a API só é chamada pelo servidor)
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt)$).*)",
  ],
};
