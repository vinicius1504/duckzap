import { readFileSync } from "node:fs";
import { createFakeLlm } from "@duckzap/ai";
import { onboardingStateSchema } from "@duckzap/contracts/onboarding";
import { sessionSchema } from "@duckzap/contracts/session";
import { createDb, schema } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../auth";
import type { Env } from "../../env";
import type { AppBindings, Deps } from "../../lib/context";
import { sessionRoutes } from "../session/routes";
import { onboardingRoutes } from "./routes";

// INTEGRAÇÃO do cadastro (/comecar) com o Better Auth REAL e o Postgres: conclusão DURÁVEL (0016), progresso derivado do
// banco e `/v1/me.organization.onboardingCompleted`. Só em banco descartável (nome diferente de "duckzap"), com
// DATABASE_URL (papel app) e DATABASE_ADMIN_URL (dono: monta canal/agente/convidado e limpa no fim).
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente
}

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_ADMIN_URL;
const dbName = url ? new URL(url).pathname.slice(1) : "";
const allowed = Boolean(url && ownerUrl) && dbName !== "duckzap";

const app = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
const owner = createDb(ownerUrl ?? "postgres://invalid/invalid", { max: 2 });
afterAll(async () => {
  await app.close();
  await owner.close();
});

const stamp = Date.now().toString(36);
const emails = {
  a: `onb-a-${stamp}@teste.duckchat.local`,
  b: `onb-b-${stamp}@teste.duckchat.local`,
  staff: `onb-staff-${stamp}@teste.duckchat.local`,
  legacy: `onb-legacy-${stamp}@teste.duckchat.local`,
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

const auth = createAuth({ env, db: app.db, sendMail: vi.fn(async () => {}) });
const deps: Deps = { env, db: app.db, auth, llm: createFakeLlm() };

function buildApi() {
  process.env.REQUIRE_2FA_FOR_ADMINS = "false";
  const api = new OpenAPIHono<AppBindings>();
  api.route("/v1", sessionRoutes(deps));
  api.route("/v1", onboardingRoutes(deps));
  return api;
}
const api = buildApi();

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function signUp(email: string) {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ name: "Dona Teste", email, password: "senha-bem-longa-123" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return { cookie: cookieOf(response), userId: body.user.id };
}

const hours = (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => ({
  day,
  open: day !== "sun",
  opensAt: day !== "sun" ? "09:00" : "",
  closesAt: day !== "sun" ? "18:00" : "",
}));

const get = (path: string, cookie: string) => api.request(path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown = {}) =>
  api.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

async function state(cookie: string) {
  const response = await get("/v1/onboarding", cookie);
  expect(response.status).toBe(200);
  return onboardingStateSchema.parse(await response.json());
}
async function me(cookie: string) {
  return sessionSchema.parse(await (await get("/v1/me", cookie)).json());
}

async function createCompany(cookie: string, name: string) {
  const response = await post("/v1/onboarding/organization", cookie, { companyName: name, businessHours: hours });
  expect(response.status).toBe(201);
  return ((await response.json()) as { organizationId: string }).organizationId;
}

describe.skipIf(!allowed)("cadastro durável (/v1/onboarding)", () => {
  const orgIds: string[] = [];
  let cookieA = "";
  let cookieB = "";
  let orgA = "";
  let orgB = "";

  beforeAll(async () => {
    cookieA = (await signUp(emails.a)).cookie;
    cookieB = (await signUp(emails.b)).cookie;
  });

  afterAll(async () => {
    if (orgIds.length) await owner.db.delete(schema.organization).where(inArray(schema.organization.id, orgIds));
    await owner.db.delete(schema.user).where(inArray(schema.user.email, Object.values(emails)));
  });

  it("conta sem empresa: GET responde o passo inicial e /v1/me diz no_organization", async () => {
    const s = await state(cookieA);
    expect(s).toMatchObject({ hasOrganization: false, company: null, role: null, whatsapp: null, channelId: null, agentId: null, completedAt: null });
    const response = await get("/v1/me", cookieA);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("no_organization");
    // concluir sem empresa não existe
    expect((await post("/v1/onboarding/complete", cookieA)).status).toBe(403);
  });

  it("empresa criada: dono, em aberto; /v1/me com onboardingCompleted=false", async () => {
    orgA = await createCompany(cookieA, `Empresa Onb A ${stamp}`);
    orgB = await createCompany(cookieB, `Empresa Onb B ${stamp}`);
    orgIds.push(orgA, orgB);
    const s = await state(cookieA);
    expect(s).toMatchObject({ hasOrganization: true, role: "owner", whatsapp: null, channelId: null, agentId: null, completedAt: null });
    expect(s.company?.companyName).toBe(`Empresa Onb A ${stamp}`);
    const session = await me(cookieA);
    expect(session.organization).toMatchObject({ id: orgA, onboardingCompleted: false });
    expect(session.user.role).toBe("owner");
  });

  it("progresso vem do banco: pular WhatsApp, canal conectado e agente", async () => {
    expect((await post("/v1/onboarding/whatsapp/skip", cookieA)).status).toBe(200);
    expect((await post("/v1/onboarding/whatsapp/skip", cookieA)).status).toBe(200); // idempotente
    expect((await state(cookieA)).whatsapp).toEqual({ method: "qr_code", status: "skipped", phone: null });

    // QR gerado e ainda não lido: o canal existe, mas não conta como conectado
    const pending = uuidv7();
    const connected = uuidv7();
    await owner.db.insert(schema.channels).values([
      { id: pending, organizationId: orgA, name: `Pendente ${stamp}`, type: "whatsapp_qr", provider: "evolution", status: "qr_pending", webhookTokenHash: `onb-${pending}`, webhookTokenEnc: "enc" },
      {
        id: connected,
        organizationId: orgA,
        name: `Oficial ${stamp}`,
        type: "whatsapp_official",
        provider: "meta_cloud",
        status: "connected",
        address: "+5511988887777",
        webhookTokenHash: `onb-${connected}`,
        webhookTokenEnc: "enc",
      },
    ]);
    const s = await state(cookieA);
    expect(s.whatsapp).toEqual({ method: "official_api", status: "connected", phone: "+5511988887777" });
    expect(s.channelId).toBe(connected);

    const agentId = uuidv7();
    await owner.db.insert(schema.agents).values({ id: agentId, organizationId: orgA, job: "support" });
    expect((await state(cookieA)).agentId).toBe(agentId);
    // ainda não concluído: ter agente não conclui
    expect((await me(cookieA)).organization.onboardingCompleted).toBe(false);
  });

  it("isolamento: a outra empresa não vê canal, agente, pulo nem conclusão da primeira", async () => {
    const s = await state(cookieB);
    expect(s).toMatchObject({ role: "owner", whatsapp: null, channelId: null, agentId: null, completedAt: null });
    expect((await post("/v1/onboarding/complete", cookieB)).status).toBe(200);
    expect((await me(cookieB)).organization.onboardingCompleted).toBe(true);
    expect((await me(cookieA)).organization.onboardingCompleted).toBe(false);
    const [rowA] = await owner.db.select().from(schema.organization).where(eq(schema.organization.id, orgA));
    expect(rowA?.onboardingCompletedAt).toBeNull();
  });

  it("concluir é idempotente: a 2ª chamada devolve a mesma data; GET e /v1/me refletem", async () => {
    const first = await post("/v1/onboarding/complete", cookieA);
    expect(first.status).toBe(200);
    const { completedAt } = (await first.json()) as { completedAt: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (await (await post("/v1/onboarding/complete", cookieA)).json()) as { completedAt: string };
    expect(second.completedAt).toBe(completedAt);
    expect(new Date((await state(cookieA)).completedAt ?? "").toISOString()).toBe(completedAt);
    expect((await me(cookieA)).organization.onboardingCompleted).toBe(true);
  });

  it("convidado (atendente) entra na empresa concluída, não conclui nada e não é dono", async () => {
    const staff = await signUp(emails.staff);
    await owner.db.insert(schema.member).values({ id: uuidv7(), organizationId: orgA, userId: staff.userId, role: "member", createdAt: new Date() });
    const s = await state(staff.cookie);
    expect(s).toMatchObject({ hasOrganization: true, role: "agent" });
    const session = await me(staff.cookie);
    expect(session.user.role).toBe("agent");
    expect(session.organization).toMatchObject({ id: orgA, onboardingCompleted: true });
    expect((await post("/v1/onboarding/complete", staff.cookie)).status).toBe(403);
    expect((await post("/v1/onboarding/whatsapp/skip", staff.cookie)).status).toBe(403);
  });

  it("backfill da 0016: empresa que já existia (sem data) fica concluída com a data de criação", async () => {
    const legacy = await signUp(emails.legacy);
    const legacyOrg = `org_legacy_${stamp}`;
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    await owner.db.insert(schema.organization).values({ id: legacyOrg, name: `Antiga ${stamp}`, slug: `antiga-${stamp}`, createdAt });
    orgIds.push(legacyOrg);
    await owner.db.insert(schema.member).values({ id: uuidv7(), organizationId: legacyOrg, userId: legacy.userId, role: "owner", createdAt });
    await owner.db.insert(schema.subscriptions).values({ id: uuidv7(), organizationId: legacyOrg, planSlug: "pro", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) });
    expect((await me(legacy.cookie)).organization.onboardingCompleted).toBe(false);

    // o UPDATE da migração, exatamente como está no arquivo (numa transação desfeita: não toca nas outras empresas)
    const migration = readFileSync(new URL("../../../../../packages/db/migrations/0016_onboarding_state.sql", import.meta.url), "utf8");
    const backfill = migration.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes("UPDATE"));
    expect(backfill).toBeDefined();
    const rollback = new Error("rollback");
    await owner.db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(backfill!));
        const [row] = await tx.select().from(schema.organization).where(eq(schema.organization.id, legacyOrg));
        expect(row?.onboardingCompletedAt?.toISOString()).toBe(createdAt.toISOString());
        // concluídas antes não mudam de data
        const [a] = await tx.select().from(schema.organization).where(eq(schema.organization.id, orgA));
        expect(a?.onboardingCompletedAt).not.toBeNull();
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });

    // aplicado à empresa antiga, o dono entra direto no app
    await owner.db.update(schema.organization).set({ onboardingCompletedAt: createdAt }).where(eq(schema.organization.id, legacyOrg));
    expect((await me(legacy.cookie)).organization.onboardingCompleted).toBe(true);
    expect((await state(legacy.cookie)).completedAt).not.toBeNull();
  });

  it("empresas do seed (já configuradas) contam como concluídas", async () => {
    const rows = await owner.db
      .select({ id: schema.organization.id, completedAt: schema.organization.onboardingCompletedAt })
      .from(schema.organization)
      .where(inArray(schema.organization.id, ["org_alvorada", "org_lume"]));
    for (const row of rows) expect(row.completedAt, row.id).not.toBeNull();
  });
});
