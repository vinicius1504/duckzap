import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, generateNonce } from "@/lib/csp";

// checagem otimista (só presença do cookie); a validação de verdade acontece no layout com a sessão
const SESSION_COOKIES = ["dz.session_token", "__Secure-dz.session_token"];
const publicPaths = ["/entrar", "/esqueci-senha", "/comecar", "/termos", "/privacidade", "/convite"];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // CSP com nonce por requisição: o Next lê o nonce do header da requisição e o layout repassa ao <Script> do tema
  const nonce = generateNonce();
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development" });

  const isPublic = publicPaths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }
  // quem já está logado e abre /entrar é tratado na página, com a sessão validada
  // (aqui um cookie inválido causaria laço entre /entrar e /inicio)
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // o layout precisa saber a rota (conta suspensa só deixa abrir Ajustes; 2FA pendente leva a Ajustes)
  requestHeaders.set("x-pathname", pathname);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // tudo menos assets, /api (proxy para a API) e arquivos públicos
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|ico|txt)$).*)"],
};
