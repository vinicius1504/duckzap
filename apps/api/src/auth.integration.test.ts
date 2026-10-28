import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "./auth";
import type { Env } from "./env";
import type { AppBindings, Deps } from "./lib/context";
import { requireAuth } from "./middleware/require-auth";
import { sessionRoutes } from "./modules/session/routes";

// INTEGRAÇÃO com o Better Auth REAL e o Postgres. Roda só em banco descartável (nome diferente de "duckzap"
// ou AUTH_INTEGRATION_ALLOW_DEV_DB=1) e precisa de DATABASE_URL (papel app) e DATABASE_ADMIN_URL (dono, para limpar).
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_ADMIN_URL;
const dbName = url ? new URL(url).pathname.slice(1) : "";
const allowed = Boolean(url && ownerUrl) && (dbName !== "duckzap" || process.env.AUTH_INTEGRATION_ALLOW_DEV_DB === "1");

const app = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
const owner = createDb(ownerUrl ?? "postgres://invalid/invalid", { max: 2 });
afterAll(async () => {
  await app.close();
  await owner.close();
});

const stamp = Date.now().toString(36);
const emails = {
  boss: `a-boss-${stamp}@teste.duckchat.local`,
  staff: `a-staff-${stamp}@teste.duckchat.local`,
};

const env: Env = {
  NODE_ENV: "test",
  PORT: 4000,
  DATABASE_URL: url ?? "",
  PUBLIC_API_URL: "http://localhost:3000/api",
  WEB_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  SMTP_URL: "smtp://127.0.0.1:1",
  MAIL_FROM: "teste@duckchat.local",
  WEB_ORIGINS: ["http://localhost:3000"],
} as Env;

const sendMail = vi.fn(async (_message: { to: string; subject: string; text: string }) => {});
const auth = createAuth({ env, db: app.db, sendMail });
const deps: Deps = { env, db: app.db, auth, llm: createFakeLlm() };

const call = (path: string, init: RequestInit = {}) =>
  auth.handler(
    new Request(`http://localhost:3000/api/v1/auth${path}`, {
      method: "POST",
      ...init,
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...init.headers },
    }),
  );

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function signUp(email: string) {
  const response = await call("/sign-up/email", { body: JSON.stringify({ name: "Teste A", email, password: "senha-bem-longa-123" }) });
  return { response, cookie: cookieOf(response) };
}

describe.skipIf(!allowed)("Better Auth real: superfície, cadastro e 2FA obrigatório", () => {
  const orgIds: string[] = [];
  let bossCookie = "";
  let staffCookie = "";
  let bossId = "";

  beforeAll(async () => {
    const boss = await signUp(emails.boss);
    expect(boss.response.status).toBe(200);
    bossCookie = boss.cookie;
    bossId = ((await boss.response.json()) as { user: { id: string } }).user.id;
    const staff = await signUp(emails.staff);
    staffCookie = staff.cookie;
    // criação da empresa pelo SERVIDOR (como o onboarding faz) continua funcionando
    const org = await auth.api.createOrganization({
      headers: new Headers({ cookie: bossCookie }),
      body: { name: `Empresa A ${stamp}`, slug: `a-${stamp}` },
    });
    if (!org) throw new Error("organização não criada");
    orgIds.push(org.id);
    // assinatura em dia (sem assinatura a conta conta como suspensa)
    await owner.db.insert(schema.subscriptions).values({
      id: crypto.randomUUID(),
      organizationId: org.id,
      planSlug: "pro",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });
    // o atendente entra na empresa do chefe com papel "member"
    const staffUser = await owner.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, emails.staff));
    await owner.db.insert(schema.member).values({ id: crypto.randomUUID(), organizationId: org.id, userId: staffUser[0]!.id, role: "member", createdAt: new Date() });
  });

  afterAll(async () => {
    await owner.db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
    await owner.db.delete(schema.user).where(inArray(schema.user.email, Object.values(emails)));
  });

  it("A2: /organization/* e outros endpoints não usados respondem 404 por HTTP (mesmo logado)", async () => {
    for (const path of ["/organization/create", "/organization/delete", "/organization/list-members", "/organization/invite-member", "/update-user", "/delete-user"]) {
      const response = await call(path, { headers: { cookie: bossCookie }, body: JSON.stringify({ name: "Outra", slug: `o-${stamp}`, organizationId: orgIds[0] }) });
      expect(response.status, path).toBe(404);
    }
    const extra = await owner.db.select({ id: schema.organization.id }).from(schema.organization).where(eq(schema.organization.slug, `o-${stamp}`));
    expect(extra).toHaveLength(0);
  });

  it("A2: o que o produto usa continua funcionando (get-session)", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3000/api/v1/auth/get-session", { headers: { cookie: bossCookie, origin: "http://localhost:3000" } }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { user: { email: string } }).user.email).toBe(emails.boss);
  });

  it("M2: cadastrar e-mail que já existe não diz que existe (e avisa o dono por e-mail)", async () => {
    sendMail.mockClear();
    const again = await call("/sign-up/email", { body: JSON.stringify({ name: "Intruso", email: emails.boss.toUpperCase(), password: "outra-senha-longa-123" }) });
    expect(again.status).toBe(422);
    const body = (await again.json()) as { code?: string; message?: string };
    expect(body.code).toBe("SIGN_UP_FAILED");
    expect(JSON.stringify(body)).not.toMatch(/already|existe|USER_ALREADY/i);
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
    expect(sendMail.mock.calls[0]?.[0]).toMatchObject({ to: emails.boss });
    // não criou uma segunda conta
    const rows = await owner.db.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${emails.boss}`);
    expect(rows).toHaveLength(1);
  });

  describe("conta suspensa = bloqueio total", () => {
    const build = () => {
      process.env.REQUIRE_2FA_FOR_ADMINS = "false";
      const api = new OpenAPIHono<AppBindings>();
      api.use("/v1/protegido/*", requireAuth(deps));
      api.get("/v1/protegido/x", (c) => c.json({ ok: true }));
      api.use("/v1/settings/billing/*", requireAuth(deps));
      api.get("/v1/settings/billing/x", (c) => c.json({ ok: true }));
      api.route("/v1", sessionRoutes(deps));
      return api;
    };
    const setStatus = (status: string) =>
      owner.db.update(schema.subscriptions).set({ status }).where(eq(schema.subscriptions.organizationId, orgIds[0]!));

    it("em dia: tudo normal; suspensa: 403 account_suspended, mas /me e cobrança respondem", async () => {
      const api = build();
      expect((await api.request("/v1/protegido/x", { headers: { cookie: bossCookie } })).status).toBe(200);
      await setStatus("canceled");
      try {
        for (const cookie of [bossCookie, staffCookie]) {
          const blocked = await api.request("/v1/protegido/x", { headers: { cookie } });
          expect(blocked.status).toBe(403);
          expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("account_suspended");
          const me = await api.request("/v1/me", { headers: { cookie } });
          expect(me.status).toBe(200);
          expect(((await me.json()) as { organization: { subscriptionStatus: string } }).organization.subscriptionStatus).toBe("canceled");
          expect((await api.request("/v1/settings/billing/x", { headers: { cookie } })).status).toBe(200);
        }
      } finally {
        await setStatus("active");
      }
      expect((await api.request("/v1/protegido/x", { headers: { cookie: bossCookie } })).status).toBe(200);
    });
  });

  describe("A1: 2FA obrigatório para Proprietário/Administrador", () => {
    const build = (require2fa: "true" | "false") => {
      process.env.REQUIRE_2FA_FOR_ADMINS = require2fa;
      const api = new OpenAPIHono<AppBindings>();
      api.use("/v1/protegido/*", requireAuth(deps));
      api.get("/v1/protegido/x", (c) => c.json({ ok: true }));
      api.route("/v1", sessionRoutes(deps));
      return api;
    };
    const get = (api: OpenAPIHono<AppBindings>, path: string, cookie: string) => api.request(path, { headers: { cookie } });

    it("owner sem 2FA: 403 two_factor_required nas rotas protegidas, mas /me responde e diz o motivo", async () => {
      const api = build("true");
      const blocked = await get(api, "/v1/protegido/x", bossCookie);
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("two_factor_required");
      const me = await get(api, "/v1/me", bossCookie);
      expect(me.status).toBe(200);
      expect(((await me.json()) as { user: { role: string; twoFactorEnabled: boolean; twoFactorRequired: boolean } }).user).toMatchObject({
        role: "owner",
        twoFactorEnabled: false,
        twoFactorRequired: true,
      });
    });

    it("atendente não é afetado", async () => {
      const api = build("true");
      expect((await get(api, "/v1/protegido/x", staffCookie)).status).toBe(200);
      const me = (await (await get(api, "/v1/me", staffCookie)).json()) as { user: { role: string; twoFactorRequired: boolean } };
      expect(me.user).toMatchObject({ role: "agent", twoFactorRequired: false });
    });

    it("com REQUIRE_2FA_FOR_ADMINS=false (dev/test) o owner passa", async () => {
      expect((await get(build("false"), "/v1/protegido/x", bossCookie)).status).toBe(200);
    });

    it("depois de ativar o 2FA o owner passa", async () => {
      await owner.db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, bossId));
      const api = build("true");
      expect((await get(api, "/v1/protegido/x", bossCookie)).status).toBe(200);
      const me = (await (await get(api, "/v1/me", bossCookie)).json()) as { user: { twoFactorEnabled: boolean; twoFactorRequired: boolean } };
      expect(me.user).toMatchObject({ twoFactorEnabled: true, twoFactorRequired: false });
      await owner.db.update(schema.user).set({ twoFactorEnabled: false }).where(eq(schema.user.id, bossId));
    });
  });
});
