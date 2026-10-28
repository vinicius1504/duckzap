import { randomBytes } from "node:crypto";
import { createFakeLlm } from "@duckzap/ai";
import { createDb, schema, withOrg } from "@duckzap/db";
import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Auth } from "../../auth";
import type { Env } from "../../env";
import type { Deps } from "../../lib/context";
import { decryptSecret } from "../../lib/crypto";
import { createApiKey, listApiKeys, requireApiKey, revokeApiKey, type ApiKeyBindings } from "./api-keys";
import { settingsRoutes } from "./routes";
import { createWebhook, deleteWebhook, listWebhooks } from "./webhooks";

// INTEGRAÇÃO: Postgres real (papel duckzap_app) + seed de dev. Depende das tabelas novas de Ajustes e
// de Equipe (api_keys, webhook_endpoints, organization_settings, integrations, member_profiles): é pulado
// até a migration única ser aplicada.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const url = process.env.DATABASE_URL;
const { db, close } = createDb(url ?? "postgres://invalid/invalid", { max: 3 });
afterAll(close);

async function tablesReady() {
  if (!url) return false;
  try {
    const rows = await db.execute<{ ok: boolean }>(
      sql`select (to_regclass('public.api_keys') is not null and to_regclass('public.webhook_endpoints') is not null
        and to_regclass('public.organization_settings') is not null and to_regclass('public.integrations') is not null
        and to_regclass('public.member_profiles') is not null) as ok`,
    );
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}
const ready = await tablesReady();

const A = "org_alvorada";
// B = "outra empresa": criada aqui, ativa, plano Básico. Nunca org_lume (o seed a deixa expirada = suspensa).
const RUN = uuidv7().slice(-8);
const B = `org_set_b_${RUN}`;
const USER_B = `usr_set_b_${RUN}`;

beforeAll(async () => {
  if (!ready) return;
  const now = new Date();
  await db.insert(schema.organization).values({ id: B, name: "Outra Empresa", slug: B, createdAt: now, timeZone: "America/Sao_Paulo" });
  await withOrg(db, B, (tx) =>
    tx.insert(schema.subscriptions).values({ id: uuidv7(), organizationId: B, planSlug: "basico", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) }),
  );
  await db.insert(schema.user).values({ id: USER_B, name: "Lia Moraes", email: `b-${RUN}@set.test`, emailVerified: true, createdAt: now, updatedAt: now });
  await db.insert(schema.member).values({ id: `mem_${USER_B}`, organizationId: B, userId: USER_B, role: "owner", createdAt: now });
});

afterAll(async () => {
  if (!ready) return;
  await db.delete(schema.organization).where(eq(schema.organization.id, B));
  await db.delete(schema.user).where(eq(schema.user.id, USER_B));
});

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
};
const people: Record<string, { name: string; email: string; org: string }> = {
  usr_marina: { name: "Marina Alves", email: "marina@casaalvorada.com.br", org: A },
  usr_rafael: { name: "Rafael Costa", email: "rafael@casaalvorada.com.br", org: A },
  [USER_B]: { name: "Lia Moraes", email: `b-${RUN}@set.test`, org: B },
};
const fakeAuth = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-user") ?? "";
      const p = people[id];
      return p ? { session: { activeOrganizationId: p.org }, user: { id, name: p.name, email: p.email } } : null;
    },
  },
};
// stub de teste: só `getSession` é usado nestes cenários
const deps = { env, db, auth: fakeAuth as unknown as Auth, llm: createFakeLlm() } satisfies Deps;
const app = settingsRoutes(deps);
const call = (user: string, path: string, init: RequestInit = {}) =>
  app.request(`http://x${path}`, { ...init, headers: { "x-test-user": user, "content-type": "application/json" } });

describe.skipIf(!ready)("Ajustes: autorização por aba (can)", () => {
  it("sem sessão: 401", async () => {
    expect((await app.request("http://x/settings/company")).status).toBe(401);
    expect((await app.request("http://x/account")).status).toBe(401);
  });

  it("atendente não acessa Empresa, Atendimento, Integrações, chaves, webhooks nem Plano", async () => {
    for (const [method, path] of [
      ["GET", "/settings/company"],
      ["PUT", "/settings/company"],
      ["GET", "/settings/service"],
      ["GET", "/settings/integrations"],
      ["POST", "/settings/integrations/google-calendar/connect"],
      ["GET", "/settings/api-keys"],
      ["POST", "/settings/api-keys"],
      ["GET", "/settings/webhooks"],
      ["POST", "/settings/webhooks"],
      ["GET", "/settings/billing"],
      ["POST", "/settings/billing/plan-change"],
    ] as const) {
      const res = await call("usr_rafael", path, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("atendente acessa a própria conta e a lista de planos", async () => {
    expect((await call("usr_rafael", "/account")).status).toBe(200);
    expect((await call("usr_rafael", "/settings/plans")).status).toBe(200);
  });

  it("proprietária lê as abas da própria empresa", async () => {
    for (const path of ["/settings/company", "/settings/service", "/settings/integrations", "/settings/api-keys", "/settings/webhooks", "/settings/billing"]) {
      expect((await call("usr_marina", path)).status, path).toBe(200);
    }
    const company = (await (await call("usr_marina", "/settings/company")).json()) as { name: string };
    expect(company.name).toBe("Casa Alvorada Odontologia");
  });

  it("integrações nunca devolvem o token inteiro", async () => {
    const res = await call("usr_marina", "/settings/integrations");
    const text = await res.text();
    expect(text).not.toContain("secretEncrypted");
    expect(text).not.toContain("v1:");
  });
});

describe.skipIf(!ready)("Ajustes: chaves de API", () => {
  it("guarda só o hash, mostra o segredo uma vez e a middleware valida/revoga", async () => {
    const created = await createApiKey(deps, A, { name: "teste integração", scopes: ["contacts:read"] });
    try {
      expect(created.secret.startsWith(`dz_live_${A}.`)).toBe(true);
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.apiKey.id)));
      expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(created.secret);
      expect(created.apiKey.last4).toBe(created.secret.slice(-4));

      const guarded = new Hono<ApiKeyBindings>();
      guarded.use("/x", requireApiKey(deps, "contacts:read"));
      guarded.get("/x", (c) => c.json({ org: c.get("apiKey").organizationId }));
      const hit = (secret?: string) =>
        guarded.request("http://x/x", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });

      const ok = await hit(created.secret);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ org: A });
      expect((await hit()).status).toBe(401);
      expect((await hit("dz_live_lixo")).status).toBe(401);
      // trocar a empresa no segredo não dá acesso a outra empresa
      expect((await hit(created.secret.replace(`dz_live_${A}.`, `dz_live_${B}.`))).status).toBe(401);

      // escopo insuficiente
      const needsWrite = new Hono<ApiKeyBindings>();
      needsWrite.use("/w", requireApiKey(deps, "contacts:write"));
      needsWrite.get("/w", (c) => c.json({}));
      expect((await needsWrite.request("http://x/w", { headers: { authorization: `Bearer ${created.secret}` } })).status).toBe(403);

      // outra empresa não vê nem revoga
      expect((await listApiKeys(deps, B)).map((k) => k.id)).not.toContain(created.apiKey.id);
      const foreign = await revokeApiKey(deps, B, created.apiKey.id);
      expect(foreign.ok).toBe(false);

      expect((await revokeApiKey(deps, A, created.apiKey.id)).ok).toBe(true);
      expect((await hit(created.secret)).status).toBe(401);
    } finally {
      await withOrg(db, A, (tx) => tx.delete(schema.apiKeys).where(eq(schema.apiKeys.id, created.apiKey.id)));
    }
  });
});

describe.skipIf(!ready)("Ajustes: webhooks de saída", () => {
  it("recusa URL interna (SSRF) ao criar", async () => {
    for (const urlToTest of ["https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://localhost/hook", "https://[::1]/hook"]) {
      const result = await createWebhook(deps, A, { url: urlToTest, events: ["message.received"] });
      expect(result.ok, urlToTest).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("unsafe_url");
    }
  });

  it("cria com segredo cifrado e mostrado uma vez; é isolado por empresa", async () => {
    const result = await createWebhook(deps, A, { url: "https://93.184.216.34/duckzap-test", events: ["message.received"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { webhook, signingSecret } = result.data;
    try {
      expect(signingSecret.startsWith("whsec_")).toBe(true);
      expect(webhook.secretLast4).toBe(signingSecret.slice(-4));
      const [row] = await withOrg(db, A, (tx) => tx.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, webhook.id)));
      // formato atual v2 (kid + AAD por empresa); o legado v1 só é lido. Decifra de volta ao segredo mostrado uma vez.
      expect(row?.secretEncrypted.startsWith("v2:")).toBe(true);
      expect(decryptSecret(A, row?.secretEncrypted ?? "")).toBe(signingSecret);
      expect(() => decryptSecret(B, row?.secretEncrypted ?? "")).toThrow(); // outra empresa não decifra
      expect(JSON.stringify(row)).not.toContain(signingSecret);

      expect((await listWebhooks(deps, B)).map((w) => w.id)).not.toContain(webhook.id);
      expect((await deleteWebhook(deps, B, webhook.id)).ok).toBe(false);
      expect((await createWebhook(deps, A, { url: "https://93.184.216.34/duckzap-test", events: ["message.sent"] })).ok).toBe(false);
    } finally {
      await withOrg(db, A, (tx) => tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, webhook.id)));
    }
  });
});

describe.skipIf(!ready)("Ajustes: plano e cobrança", () => {
  it("usa os planos da tabela e calcula o uso", async () => {
    const billing = (await (await call("usr_marina", "/settings/billing")).json()) as {
      plans: { slug: string }[];
      currentPlan: string;
      usage: { users: number };
      invoices: unknown[];
    };
    expect(billing.plans.map((p) => p.slug)).toEqual(["basico", "pro", "empresarial"]);
    expect(billing.usage.users).toBeGreaterThanOrEqual(2);
    expect(billing.invoices).toEqual([]);
  });

  it("mesmo plano é recusado; upgrade devolve o placeholder [LINK]", async () => {
    const same = await call("usr_marina", "/settings/billing/plan-change", { method: "POST", body: JSON.stringify({ plan: "pro" }) });
    expect(same.status).toBe(409);
    const up = await call("usr_marina", "/settings/billing/plan-change", { method: "POST", body: JSON.stringify({ plan: "empresarial" }) });
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ checkoutUrl: "[LINK]" });
  });
});
