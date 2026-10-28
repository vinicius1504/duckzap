import { describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER, createMemoryLoginThrottle, guardAuthHandler, isAllowedAuthPath } from "./auth-handler";

const BASE = "/api/v1/auth";
const url = (path: string) => `http://localhost:4000${BASE}${path}`;

describe("superfície do Better Auth exposta por HTTP (A2)", () => {
  it("libera só entrar, cadastrar, sair, sessão, senha e 2FA", () => {
    for (const path of [
      "/sign-in/email",
      "/sign-up/email",
      "/sign-out",
      "/get-session",
      "/request-password-reset",
      "/reset-password",
      "/reset-password/abc123",
      "/change-password",
      "/two-factor/enable",
      "/two-factor/verify-totp",
      "/two-factor/generate-backup-codes",
      "/list-sessions",
    ]) {
      expect(isAllowedAuthPath(path), path).toBe(true);
    }
  });

  it("bloqueia /organization/* e o resto que o produto não usa", () => {
    for (const path of [
      "/organization/create",
      "/organization/delete",
      "/organization/invite-member",
      "/organization/list-members",
      "/organization/get-full-organization",
      "/organization/accept-invitation",
      "/organization/update-member-role",
      "/update-user",
      "/delete-user",
      "/change-email",
      "/link-social",
      "/unlink-account",
      "/two-factor/",
      "/sign-in/email/../organization/list",
      "/",
    ]) {
      expect(isAllowedAuthPath(path), path).toBe(false);
    }
  });

  it("o handler devolve 404 para /organization/* sem chamar o Better Auth", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const handler = guardAuthHandler(inner, { basePath: BASE, trustProxy: false });
    for (const path of ["/organization/create", "/organization/delete", "/organization/list-members"]) {
      const response = await handler(new Request(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      expect(response.status).toBe(404);
    }
    expect(inner).not.toHaveBeenCalled();
  });
});

describe("IP confiável para o limite do Better Auth (A3)", () => {
  const seen = async (options: { trustProxy: boolean }, headers: Record<string, string>) => {
    let received: Headers | null = null;
    const handler = guardAuthHandler(
      async (request) => {
        received = request.headers;
        return new Response("ok");
      },
      { basePath: BASE, ...options },
    );
    await handler(new Request(url("/get-session"), { headers }));
    return received as unknown as Headers;
  };

  it("cabeçalho interno vindo do cliente é apagado", async () => {
    const headers = await seen({ trustProxy: false }, { [CLIENT_IP_HEADER]: "9.9.9.9", "x-forwarded-for": "8.8.8.8" });
    expect(headers.get(CLIENT_IP_HEADER)).toBeNull();
  });

  it("atrás de proxy confiável usa o ÚLTIMO item de x-forwarded-for", async () => {
    const headers = await seen({ trustProxy: true }, { [CLIENT_IP_HEADER]: "9.9.9.9", "x-forwarded-for": "8.8.8.8, 198.51.100.7" });
    expect(headers.get(CLIENT_IP_HEADER)).toBe("198.51.100.7");
  });

  it("preserva o corpo da requisição ao reescrever os cabeçalhos", async () => {
    let body = "";
    const handler = guardAuthHandler(
      async (request) => {
        body = await request.text();
        return new Response("ok");
      },
      { basePath: BASE, trustProxy: true },
    );
    await handler(new Request(url("/sign-up/email"), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, body: '{"a":1}' }));
    expect(body).toBe('{"a":1}');
  });
});

describe("limite de login por conta (A3)", () => {
  const signIn = (email: string, ip = "198.51.100.7") =>
    new Request(url("/sign-in/email"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: "x" }),
    });

  it("depois de 8 falhas no mesmo e-mail responde 429, mesmo trocando de IP", async () => {
    const inner = vi.fn(async () => new Response("{}", { status: 401 }));
    const handler = guardAuthHandler(inner, { basePath: BASE, trustProxy: true, loginThrottle: createMemoryLoginThrottle({ maxFailures: 8 }) });
    for (let i = 0; i < 8; i++) expect((await handler(signIn("Vitima@Empresa.com", `203.0.113.${i + 1}`))).status).toBe(401);
    const blocked = await handler(signIn("vitima@empresa.com", "203.0.113.200"));
    expect(blocked.status).toBe(429);
    expect(inner).toHaveBeenCalledTimes(8);
    // outro e-mail não é afetado
    expect((await handler(signIn("outra@empresa.com"))).status).toBe(401);
  });

  it("login correto zera a contagem; a janela expira", async () => {
    let now = 0;
    const throttle = createMemoryLoginThrottle({ maxFailures: 2, windowMs: 1000, now: () => now });
    let status = 401;
    const handler = guardAuthHandler(async () => new Response("{}", { status }), { basePath: BASE, trustProxy: false, loginThrottle: throttle });
    await handler(signIn("a@x.com"));
    status = 200;
    await handler(signIn("a@x.com"));
    status = 401;
    await handler(signIn("a@x.com"));
    expect((await handler(signIn("a@x.com"))).status).toBe(401); // só 2 falhas desde o zeramento: ainda não bloqueou
    expect((await handler(signIn("a@x.com"))).status).toBe(429);
    now = 1001;
    expect((await handler(signIn("a@x.com"))).status).toBe(401);
  });
});
