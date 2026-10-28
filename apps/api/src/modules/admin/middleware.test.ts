import type { Database } from "@duckzap/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AdminPrincipal } from "./auth-service";
import { loadAdminConfig } from "./config";
import { parseAllowlist } from "./ip";
import { adminGuard, requireAdmin, type AdminBindings } from "./middleware";
import { RateLimiter } from "./rate-limit";

const fakeDb = {} as Database;
const principal: AdminPrincipal = {
  id: "7f1b3a66-0000-7000-8000-000000000001",
  name: "Bruno",
  email: "bruno@duckchat.com.br",
  sessionId: "s1",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
};

function buildApp(env: Record<string, string> = {}, db: Database | null = fakeDb) {
  const config = loadAdminConfig(env as NodeJS.ProcessEnv);
  const app = new Hono<AdminBindings>();
  app.use(
    "/admin/*",
    adminGuard({ config, rules: parseAllowlist(config.ADMIN_IP_ALLOWLIST), getDb: () => db, globalLimiter: new RateLimiter({ max: 1000, windowMs: 60_000 }) }),
  );
  const authed = new Hono<AdminBindings>();
  authed.use("*", requireAdmin(async (_db, token) => (token === "token-admin-valido" ? principal : null)));
  authed.get("/ping", (c) => c.json({ admin: c.get("admin").email }));
  authed.post("/mutate", (c) => c.json({ ok: true }));
  app.route("/admin", authed);
  return app;
}

describe("requireAdmin: identidades separadas", () => {
  it("sem cookie => 401", async () => {
    expect((await buildApp().request("/admin/ping")).status).toBe(401);
  });

  it("sessão de CLIENTE (cookie do Better Auth) não abre /v1/admin => 401", async () => {
    for (const cookie of ["dz.session_token=abc.def", "__Secure-dz.session_token=abc.def", "dz_session=abc", "session=abc"]) {
      const res = await buildApp().request("/admin/ping", { headers: { cookie } });
      expect(res.status).toBe(401);
    }
  });

  it("cookie dz_admin desconhecido/expirado/revogado => 401, sem detalhe", async () => {
    const res = await buildApp().request("/admin/ping", { headers: { cookie: "dz_admin=qualquer-coisa" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Entre para continuar." } });
  });

  it("cookie dz_admin gigante é recusado sem consultar o banco", async () => {
    const res = await buildApp().request("/admin/ping", { headers: { cookie: `dz_admin=${"a".repeat(500)}` } });
    expect(res.status).toBe(401);
  });

  it("sessão de admin válida passa", async () => {
    const res = await buildApp().request("/admin/ping", { headers: { cookie: "dz_admin=token-admin-valido" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ admin: "bruno@duckchat.com.br" });
  });
});

describe("adminGuard", () => {
  it("responde sem cache", async () => {
    const res = await buildApp().request("/admin/ping", { headers: { cookie: "dz_admin=token-admin-valido" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("escrita sem Origin, ou de origem estranha, é recusada mesmo com sessão", async () => {
    const headers = { cookie: "dz_admin=token-admin-valido" };
    expect((await buildApp().request("/admin/mutate", { method: "POST", headers })).status).toBe(403);
    expect((await buildApp().request("/admin/mutate", { method: "POST", headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
    expect((await buildApp().request("/admin/mutate", { method: "POST", headers: { ...headers, origin: "http://localhost:3002" } })).status).toBe(200);
  });

  it("allowlist: IP fora da lista => 403 (com proxy confiável, via x-forwarded-for)", async () => {
    const app = buildApp({ ADMIN_IP_ALLOWLIST: "177.12.40.0/24", ADMIN_TRUST_PROXY: "true" });
    const headers = { cookie: "dz_admin=token-admin-valido" };
    expect((await app.request("/admin/ping", { headers: { ...headers, "x-forwarded-for": "8.8.8.8" } })).status).toBe(403);
    expect((await app.request("/admin/ping", { headers: { ...headers, "x-forwarded-for": "177.12.40.9" } })).status).toBe(200);
  });

  it("allowlist sem proxy confiável: x-forwarded-for forjado não vale (sem socket => negado)", async () => {
    const app = buildApp({ ADMIN_IP_ALLOWLIST: "177.12.40.0/24" });
    const res = await app.request("/admin/ping", { headers: { cookie: "dz_admin=token-admin-valido", "x-forwarded-for": "177.12.40.9" } });
    expect(res.status).toBe(403);
  });

  it("sem banco do painel configurado => 503", async () => {
    const res = await buildApp({}, null).request("/admin/ping");
    expect(res.status).toBe(503);
  });

  it("rate limit global por IP => 429", async () => {
    const config = loadAdminConfig({} as NodeJS.ProcessEnv);
    const app = new Hono<AdminBindings>();
    app.use("/admin/*", adminGuard({ config, rules: [], getDb: () => fakeDb, globalLimiter: new RateLimiter({ max: 2, windowMs: 60_000 }) }));
    app.get("/admin/x", (c) => c.text("ok"));
    expect((await app.request("/admin/x")).status).toBe(200);
    expect((await app.request("/admin/x")).status).toBe(200);
    expect((await app.request("/admin/x")).status).toBe(429);
  });
});
