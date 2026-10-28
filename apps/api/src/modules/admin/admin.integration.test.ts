import { randomBytes } from "node:crypto";
import { createDb, schema, type Database } from "@duckzap/db";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { createAuth } from "../../auth";
import { requireAuth } from "../../middleware/require-auth";
import { activationCodeFor } from "./activation";
import { AuditReasonError } from "./audit";
import { createLimiters, getAdminSession, getChallenge, signOut, startSignIn, verifyTwoFactor } from "./auth-service";
import { changeCompanyPlan, deletePlan, extendCompany, setCompanyEnabled } from "./commands";
import { loadAdminConfig } from "./config";
import { getCompany, listAuditEntries, listCompanies } from "./queries";
import { adminRoutes } from "./routes";
import { totpCode } from "./totp";

// INTEGRAÇÃO — precisa do Postgres do Docker com a migration das tabelas de admin e `db:roles` aplicados,
// e dos dados do seed (org_alvorada, org_lume, planos basico/pro/empresarial).
// Liga com ADMIN_INTEGRATION=1, ADMIN_DATABASE_URL (duckzap_admin), DATABASE_URL (duckzap_app) e
// DATABASE_ADMIN_URL (dono do banco; só para criar/apagar os admins de teste — o papel do painel NÃO cria admins).
// Tudo roda dentro de UMA transação desfeita no fim: audit_logs é append-only, então nada pode "sobrar".
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const enabled = Boolean(
  process.env.ADMIN_INTEGRATION && process.env.ADMIN_DATABASE_URL && process.env.DATABASE_URL && process.env.DATABASE_ADMIN_URL,
);
const PASSWORD = "Senha-forte-de-teste-123";
const ORIGIN = "http://localhost:3002";

const admin = enabled ? createDb(process.env.ADMIN_DATABASE_URL as string, { max: 1 }) : null;
const customer = enabled ? createDb(process.env.DATABASE_URL as string, { max: 1 }) : null;
const owner = enabled ? createDb(process.env.DATABASE_ADMIN_URL as string, { max: 1 }) : null;
const createdAdminIds: string[] = [];
afterAll(async () => {
  // sessões, desafios e auditoria dos testes foram desfeitos no rollback; sobram só os admins criados pelo dono
  for (const id of createdAdminIds) await owner?.db.delete(schema.platformAdmins).where(sql`${schema.platformAdmins.id} = ${id}`);
  await admin?.close();
  await customer?.close();
  await owner?.close();
});

/** Executa `fn` com um "banco" que é a transação, e desfaz tudo no fim. */
async function inRollback(fn: (db: Database) => Promise<void>) {
  const marker = new Error("rollback");
  try {
    await admin!.db.transaction(async (tx) => {
      await fn(tx as unknown as Database);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

async function createAdmin(_db: Database, email = `teste-${uuidv7()}@duckchat.test`) {
  const id = uuidv7();
  await owner!.db.insert(schema.platformAdmins).values({ id, email, name: "Admin de Teste", passwordHash: await hashPassword(PASSWORD) });
  createdAdminIds.push(id);
  return { id, email };
}

const ctx = { ip: "177.12.40.8", userAgent: "vitest" };

describe.skipIf(!enabled)("login do painel (senha + TOTP obrigatório)", () => {
  it("1º login faz enrollment, entra e o logout revoga a sessão no banco", async () => {
    await inRollback(async (db) => {
      const limiters = createLimiters();
      const { email } = await createAdmin(db);
      const start = await startSignIn(db, limiters, { email, password: PASSWORD }, ctx);
      if (!start.ok) throw new Error("login falhou");
      expect(start.needsEnrollment).toBe(true);

      const info = await getChallenge(db, start.challengeToken);
      expect(info?.enrollment?.secret).toMatch(/^[A-Z2-7]{32}$/);

      const now = new Date();
      const verified = await verifyTwoFactor(db, limiters, { challengeToken: start.challengeToken, code: totpCode(info!.enrollment!.secret, now.getTime()) }, ctx, now);
      if (!verified.ok) throw new Error("2FA falhou");

      const principal = await getAdminSession(db, verified.sessionToken);
      expect(principal?.email).toBe(email);
      // o banco guarda só o hash do token
      const [row] = await db.select().from(schema.adminSessions);
      expect(row?.tokenHash).not.toBe(verified.sessionToken);

      await signOut(db, principal!, ctx);
      expect(await getAdminSession(db, verified.sessionToken)).toBeNull();
    });
  });

  it("M4: 1º acesso (cadastro do 2FA) exige o código de ativação; senha sozinha não basta", async () => {
    await inRollback(async (db) => {
      const limiters = createLimiters();
      const { id, email } = await createAdmin(db);
      const opts = { requireActivation: true };
      const semCodigo = await startSignIn(db, limiters, { email, password: PASSWORD }, ctx, new Date(), opts);
      expect(semCodigo).toMatchObject({ ok: false, code: "activation_required" });
      const errado = await startSignIn(db, limiters, { email, password: PASSWORD, activationCode: "AAAAA-AAAAA-AAAAA-AAAAA" }, ctx, new Date(), opts);
      expect(errado).toMatchObject({ ok: false, code: "activation_required" });
      const certo = await startSignIn(db, limiters, { email, password: PASSWORD, activationCode: activationCodeFor(id) }, ctx, new Date(), opts);
      expect(certo).toMatchObject({ ok: true, needsEnrollment: true });
      // sem exigência (dev/test) o fluxo antigo segue valendo
      expect(await startSignIn(db, limiters, { email, password: PASSWORD }, ctx, new Date(), { requireActivation: false })).toMatchObject({ ok: true });
    });
  });

  it("mensagem de erro é igual para senha errada e e-mail inexistente", async () => {
    await inRollback(async (db) => {
      const limiters = createLimiters();
      const { email } = await createAdmin(db);
      const wrong = await startSignIn(db, limiters, { email, password: "errada-errada" }, ctx);
      const unknown = await startSignIn(db, limiters, { email: `ninguem-${uuidv7()}@duckchat.test`, password: "errada-errada" }, ctx);
      expect(wrong).toEqual(unknown);
      expect(wrong.ok).toBe(false);
    });
  });

  it("5 códigos errados encerram o desafio (precisa recomeçar)", async () => {
    await inRollback(async (db) => {
      const limiters = createLimiters();
      const { email } = await createAdmin(db);
      const start = await startSignIn(db, limiters, { email, password: PASSWORD }, ctx);
      if (!start.ok) throw new Error("login falhou");
      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await verifyTwoFactor(db, limiters, { challengeToken: start.challengeToken, code: "000000" }, ctx);
        results.push(r.ok ? "ok" : r.code);
      }
      expect(results).toEqual(["invalid_code", "invalid_code", "invalid_code", "invalid_code", "too_many_attempts", "expired"]);
    });
  });

  it("o mesmo código TOTP não vale duas vezes", async () => {
    await inRollback(async (db) => {
      const limiters = createLimiters();
      const { email } = await createAdmin(db);
      const first = await startSignIn(db, limiters, { email, password: PASSWORD }, ctx);
      if (!first.ok) throw new Error("login falhou");
      const secret = (await getChallenge(db, first.challengeToken))!.enrollment!.secret;
      const now = new Date();
      const code = totpCode(secret, now.getTime());
      expect((await verifyTwoFactor(db, limiters, { challengeToken: first.challengeToken, code }, ctx, now)).ok).toBe(true);

      const second = await startSignIn(db, limiters, { email, password: PASSWORD }, ctx);
      if (!second.ok) throw new Error("login falhou");
      expect(second.needsEnrollment).toBe(false);
      const replay = await verifyTwoFactor(db, limiters, { challengeToken: second.challengeToken, code }, ctx, now);
      expect(replay.ok).toBe(false);
    });
  });
});

describe.skipIf(!enabled)("mutações auditadas na mesma transação", () => {
  const actor = { id: null, name: "Admin de Teste", email: "teste@duckchat.test" };

  it("trocar o plano grava a linha de auditoria junto (quem, empresa, antes→depois, motivo, IP)", async () => {
    await inRollback(async (db) => {
      const before = await getCompany(db, "org_alvorada");
      const planId = before?.planId === "empresarial" ? "pro" : "empresarial"; // planos atuais: basico, pro, empresarial
      const result = await changeCompanyPlan(db, { actor, ip: "177.12.40.8" }, { companyId: "org_alvorada", planId, reason: "Cliente pediu upgrade por telefone." });
      expect(result.ok).toBe(true);
      const log = await listAuditEntries(db, { filter: "companies", search: "", companyId: "org_alvorada", page: 1 });
      expect(log.items[0]).toMatchObject({
        action: "company.plan_changed",
        reason: "Cliente pediu upgrade por telefone.",
        ip: "177.12.40.8",
        company: { id: "org_alvorada" },
      });
      expect(log.items[0]?.changes[0]).toMatchObject({ field: "Plano" });
      expect((await getCompany(db, "org_alvorada"))?.planId).toBe(planId);
    });
  });

  it("plano que não existe mais (essencial/escala) é recusado e não grava auditoria", async () => {
    await inRollback(async (db) => {
      for (const planId of ["essencial", "escala"]) {
        const result = await changeCompanyPlan(db, { actor, ip: null }, { companyId: "org_alvorada", planId, reason: "Plano antigo não deve existir mais." });
        expect(result.ok, planId).toBe(false);
      }
      const log = await listAuditEntries(db, { filter: "companies", search: "", companyId: "org_alvorada", page: 1 });
      expect(log.items.some((entry) => entry.action === "company.plan_changed")).toBe(false);
    });
  });

  it("sem motivo válido a mutação inteira é desfeita", async () => {
    await inRollback(async (db) => {
      const before = await getCompany(db, "org_alvorada");
      await expect(
        setCompanyEnabled(db, { actor, ip: null }, { companyId: "org_alvorada", enabled: !before!.enabled, reason: "curto" }),
      ).rejects.toBeInstanceOf(AuditReasonError);
      expect((await getCompany(db, "org_alvorada"))?.enabled).toBe(before?.enabled);
    });
  });

  it("estender vencimento e desativar/ativar atualizam o status calculado", async () => {
    await inRollback(async (db) => {
      const disabled = await setCompanyEnabled(db, { actor, ip: null }, { companyId: "org_alvorada", enabled: false, reason: "Teste de desativação manual." });
      expect(disabled.ok && disabled.data.status).toBe("disabled");
      const enabledAgain = await setCompanyEnabled(db, { actor, ip: null }, { companyId: "org_alvorada", enabled: true, reason: "Teste de reativação manual." });
      expect(enabledAgain.ok && enabledAgain.data.enabled).toBe(true);
      const tooEarly = await extendCompany(db, { actor, ip: null }, { companyId: "org_alvorada", dueDate: "2000-01-01", reason: "Data no passado deve falhar." });
      expect(tooEarly).toMatchObject({ ok: false, error: "invalid" });
    });
  });

  it("não exclui plano em uso", async () => {
    await inRollback(async (db) => {
      const result = await deletePlan(db, { actor, ip: null }, "pro", "Tentativa de excluir plano em uso.");
      expect(result).toMatchObject({ ok: false, error: "in_use" });
    });
  });

  it("a empresa do seed org_lume aparece expirada (suspensa) e a org_alvorada em dia", async () => {
    await inRollback(async (db) => {
      expect((await getCompany(db, "org_lume"))?.status).toBe("expired");
      expect((await getCompany(db, "org_alvorada"))?.status).toBe("active");
    });
  });

  it("status calculado no SQL bate com a regra pura (logic.ts)", async () => {
    await inRollback(async (db) => {
      const { companyStatusOf, dateInPlatformTz } = await import("./logic");
      const page = await listCompanies(db, { filter: "all", search: "", page: 1 });
      const today = dateInPlatformTz(new Date());
      for (const company of page.items) {
        expect(company.status).toBe(companyStatusOf({ enabled: company.enabled, onTrial: company.onTrial, dueDate: company.dueDate, today }));
      }
    });
  });
});

describe.skipIf(!enabled)("rotas /v1/admin e separação de identidades", () => {
  function buildAdminApp(db: Database) {
    const config = loadAdminConfig({ ADMIN_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);
    const routes = adminRoutes({} as never, { db, config, limiters: createLimiters() });
    return new Hono().route("/v1", routes);
  }

  it("cookie de sessão de cliente não abre /v1/admin", async () => {
    await inRollback(async (db) => {
      const res = await buildAdminApp(db).request("/v1/admin/companies", { headers: { cookie: "dz.session_token=abc.def" } });
      expect(res.status).toBe(401);
    });
  });

  it("fluxo completo por HTTP: sign-in → verify (cookie dz_admin Strict) → leitura → sign-out", async () => {
    await inRollback(async (db) => {
      const app = buildAdminApp(db);
      const { email } = await createAdmin(db);
      const post = (path: string, payload: unknown, cookie?: string) =>
        app.request(`/v1/admin${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
          body: JSON.stringify(payload),
        });

      const signIn = await post("/auth/sign-in", { email, password: PASSWORD });
      expect(signIn.status).toBe(200);
      const { challengeToken } = (await signIn.json()) as { challengeToken: string };

      const challenge = await app.request("/v1/admin/auth/challenge", { headers: { "x-admin-challenge": challengeToken } });
      const { enrollment } = (await challenge.json()) as { enrollment: { secret: string } };

      const verify = await post("/auth/verify", { challengeToken, code: totpCode(enrollment.secret, Date.now()) });
      expect(verify.status).toBe(200);
      const setCookie = verify.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/^dz_admin=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      const cookie = setCookie.split(";")[0] as string;

      expect((await app.request("/v1/admin/companies", { headers: { cookie } })).status).toBe(200);
      expect((await post("/companies/org_alvorada/enabled", { enabled: true, reason: "curto" }, cookie)).status).toBe(422);
      expect((await post("/auth/sign-out", {}, cookie)).status).toBe(200);
      expect((await app.request("/v1/admin/companies", { headers: { cookie } })).status).toBe(401);
    });
  });

  it("sessão de admin não abre rotas de cliente (requireAuth do Better Auth)", async () => {
    const auth = createAuth({
      env: {
        NODE_ENV: "test",
        PORT: 4000,
        DATABASE_URL: process.env.DATABASE_URL as string,
        PUBLIC_API_URL: "http://localhost:3000/api",
        WEB_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "x".repeat(32),
        SMTP_URL: "smtp://127.0.0.1:1026",
        MAIL_FROM: "t@t",
        WEB_ORIGINS: ["http://localhost:3000"],
      },
      db: customer!.db,
      sendMail: async () => {},
    });
    const app = new Hono();
    app.use("/me", requireAuth({ auth }));
    app.get("/me", (c) => c.json({ ok: true }));
    const res = await app.request("/me", { headers: { cookie: "dz_admin=token-de-admin-qualquer" } });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!enabled)("uso por empresa tolera tabelas ausentes", () => {
  it("lista empresas mesmo sem tabelas de canais/agentes (uso = 0)", async () => {
    const rows = await admin!.db.execute<{ n: number }>(sql`select count(*)::int as n from subscriptions`);
    expect((rows[0]?.n ?? 0) > 0).toBe(true);
    const page = await listCompanies(admin!.db, { filter: "all", search: "", page: 1 });
    for (const company of page.items) expect(company.usage.channels).toBeGreaterThanOrEqual(0);
  });
});
