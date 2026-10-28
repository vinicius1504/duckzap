import {
  adminSignInSchema,
  adminTwoFactorSchema,
  auditFilterSchema,
  changeCompanyPlanSchema,
  companyFilterSchema,
  extendCompanySchema,
  planInputSchema,
  setCompanyEnabledSchema,
  subscriptionFilterSchema,
  type AdminSession,
} from "@duckzap/contracts/admin";
import type { Database } from "@duckzap/db";
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../../lib/context";
import { AuditReasonError } from "./audit";
import {
  ADMIN_COOKIE,
  createLimiters,
  getChallenge,
  SESSION_TTL_MS,
  signOut,
  startSignIn,
  verifyTwoFactor,
  type Limiters,
} from "./auth-service";
import { changeCompanyPlan, createPlan, deletePlan, extendCompany, listPlans, setCompanyEnabled, updatePlan, type Ctx } from "./commands";
import { getAdminDb, loadAdminConfig, type AdminConfig } from "./config";
import { parseAllowlist } from "./ip";
import { adminGuard, reply, requireAdmin, type AdminBindings } from "./middleware";
import {
  getCompanyCounts,
  getCompanyDetail,
  getPlatformOverview,
  getSubscription,
  getSubscriptionCounts,
  listAuditEntries,
  listCompanies,
  listInvoices,
  listSubscriptions,
} from "./queries";
import { RateLimiter } from "./rate-limit";

type C = Context<AdminBindings>;

/** Valida o corpo JSON com o schema Zod do contrato; falha vira 422 em pt-BR. */
async function body<S extends z.ZodType>(c: C, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, response: reply(c, 422, "validation_error", parsed.error.issues[0]?.message ?? "Confira os dados e tente de novo.") };
}

function query<S extends z.ZodType>(c: C, schema: S): { ok: true; data: z.infer<S> } | { ok: false; response: Response } {
  const parsed = schema.safeParse(c.req.query());
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, response: reply(c, 422, "validation_error", "Parâmetros inválidos.") };
}

const page = z.coerce.number().int().min(1).max(100_000).default(1);
const search = z.string().max(100).default("");
const companiesQuery = z.object({ filter: companyFilterSchema.default("all"), search, page });
const subscriptionsQuery = z.object({ filter: subscriptionFilterSchema.default("all"), search, page });
const auditQuery = z.object({ filter: auditFilterSchema.default("all"), search, companyId: z.string().min(1).max(100).optional(), page });
const deleteBody = z.object({ reason: planInputSchema.shape.reason });
const verifyBody = adminTwoFactorSchema.extend({ challengeToken: z.string().min(20).max(200) });

const COMMAND_STATUS: Record<string, ContentfulStatusCode> = {
  not_found: 404,
  invalid: 422,
  duplicate: 409,
  unchanged: 409,
  in_use: 409,
};

function commandError(c: C, result: { error: string; message: string }) {
  return reply(c, COMMAND_STATUS[result.error] ?? 422, result.error, result.message);
}

export type AdminRouteOptions = {
  /** conexão do painel (papel duckzap_admin); em teste, injete um banco de teste */
  db?: Database;
  config?: AdminConfig;
  limiters?: Limiters;
};

/**
 * Rotas /v1/admin/*. Registro (feito pelo orquestrador): ver relatório.
 * Autenticação própria (tabela platform_admins + cookie `dz_admin`), banco próprio (ADMIN_DATABASE_URL).
 */
export function adminRoutes(_deps: Deps, options: AdminRouteOptions = {}) {
  const config = options.config ?? loadAdminConfig();
  const limiters = options.limiters ?? createLimiters();
  const rules = parseAllowlist(config.ADMIN_IP_ALLOWLIST);
  const getDb = () => options.db ?? getAdminDb(config);

  const app = new OpenAPIHono<AdminBindings>();
  app.use(
    "/admin/*",
    adminGuard({ config, rules, getDb, globalLimiter: new RateLimiter({ max: 600, windowMs: 60_000 }) }),
  );

  const cookieOptions = (maxAgeSeconds: number) =>
    ({
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "Strict",
      path: "/",
      maxAge: maxAgeSeconds,
    }) as const;

  const authContext = (c: C) => ({ ip: c.get("adminIp"), userAgent: c.req.header("user-agent") ?? null });

  /* ───────────── autenticação (públicas até o 2FA) ───────────── */

  app.post("/admin/auth/sign-in", async (c) => {
    const parsed = await body(c, adminSignInSchema);
    if (!parsed.ok) return parsed.response;
    const result = await startSignIn(c.get("adminDb"), limiters, parsed.data, authContext(c));
    if (!result.ok) return reply(c, result.code === "rate_limited" ? 429 : 401, result.code, result.message);
    return c.json({ challengeToken: result.challengeToken, expiresAt: result.expiresAt, needsEnrollment: result.needsEnrollment }, 200);
  });

  app.get("/admin/auth/challenge", async (c) => {
    const token = c.req.header("x-admin-challenge");
    const info = token && token.length <= 200 ? await getChallenge(c.get("adminDb"), token) : null;
    if (!info) return reply(c, 404, "expired", "O tempo para digitar o código acabou. Entre de novo.");
    return c.json(info, 200);
  });

  app.post("/admin/auth/verify", async (c) => {
    const parsed = await body(c, verifyBody);
    if (!parsed.ok) return parsed.response;
    const result = await verifyTwoFactor(c.get("adminDb"), limiters, parsed.data, authContext(c));
    if (!result.ok) {
      const status: ContentfulStatusCode = result.code === "too_many_attempts" || result.code === "rate_limited" ? 429 : 401;
      return reply(c, status, result.code, result.message);
    }
    setCookie(c, ADMIN_COOKIE, result.sessionToken, cookieOptions(SESSION_TTL_MS / 1000));
    const session: AdminSession = { admin: result.admin, expiresAt: result.expiresAt };
    return c.json(session, 200);
  });

  /* ───────────── rotas autenticadas ───────────── */

  const authed = new OpenAPIHono<AdminBindings>();
  authed.use("*", requireAdmin());

  const ctxOf = (c: C): Ctx => {
    const admin = c.get("admin");
    return { actor: { id: admin.id, name: admin.name, email: admin.email }, ip: c.get("adminIp") };
  };

  authed.get("/auth/session", (c) => {
    const admin = c.get("admin");
    const session: AdminSession = {
      admin: { id: admin.id, name: admin.name, email: admin.email },
      expiresAt: admin.expiresAt.toISOString(),
    };
    return c.json(session, 200);
  });

  authed.post("/auth/sign-out", async (c) => {
    await signOut(c.get("adminDb"), c.get("admin"), authContext(c));
    deleteCookie(c, ADMIN_COOKIE, { path: "/" });
    return c.json({ ok: true }, 200);
  });

  authed.get("/overview", async (c) => c.json(await getPlatformOverview(c.get("adminDb")), 200));

  // empresas
  authed.get("/companies", async (c) => {
    const q = query(c, companiesQuery);
    if (!q.ok) return q.response;
    return c.json(await listCompanies(c.get("adminDb"), q.data), 200);
  });
  authed.get("/companies/counts", async (c) => c.json(await getCompanyCounts(c.get("adminDb")), 200));
  authed.get("/companies/:id", async (c) => {
    const detail = await getCompanyDetail(c.get("adminDb"), c.req.param("id"));
    return detail ? c.json(detail, 200) : reply(c, 404, "not_found", "Empresa não encontrada.");
  });

  authed.post("/companies/:id/plan", async (c) => {
    const parsed = await body(c, changeCompanyPlanSchema.omit({ companyId: true }));
    if (!parsed.ok) return parsed.response;
    const result = await changeCompanyPlan(c.get("adminDb"), ctxOf(c), { ...parsed.data, companyId: c.req.param("id") });
    return result.ok ? c.json(result.data, 200) : commandError(c, result);
  });
  authed.post("/companies/:id/extend", async (c) => {
    const parsed = await body(c, extendCompanySchema.omit({ companyId: true }));
    if (!parsed.ok) return parsed.response;
    const result = await extendCompany(c.get("adminDb"), ctxOf(c), { ...parsed.data, companyId: c.req.param("id") });
    return result.ok ? c.json(result.data, 200) : commandError(c, result);
  });
  authed.post("/companies/:id/enabled", async (c) => {
    const parsed = await body(c, setCompanyEnabledSchema.omit({ companyId: true }));
    if (!parsed.ok) return parsed.response;
    const result = await setCompanyEnabled(c.get("adminDb"), ctxOf(c), { ...parsed.data, companyId: c.req.param("id") });
    return result.ok ? c.json(result.data, 200) : commandError(c, result);
  });

  // assinaturas e faturas (somente leitura)
  authed.get("/subscriptions", async (c) => {
    const q = query(c, subscriptionsQuery);
    if (!q.ok) return q.response;
    return c.json(await listSubscriptions(c.get("adminDb"), q.data), 200);
  });
  authed.get("/subscriptions/counts", async (c) => c.json(await getSubscriptionCounts(c.get("adminDb")), 200));
  authed.get("/subscriptions/:id", async (c) => {
    const subscription = await getSubscription(c.get("adminDb"), c.req.param("id"));
    return subscription ? c.json(subscription, 200) : reply(c, 404, "not_found", "Assinatura não encontrada.");
  });
  authed.get("/subscriptions/:id/invoices", async (c) => c.json(await listInvoices(c.get("adminDb"), c.req.param("id")), 200));

  // planos
  authed.get("/plans", async (c) => c.json(await listPlans(c.get("adminDb")), 200));
  authed.post("/plans", async (c) => {
    const parsed = await body(c, planInputSchema);
    if (!parsed.ok) return parsed.response;
    const result = await createPlan(c.get("adminDb"), ctxOf(c), parsed.data);
    return result.ok ? c.json(result.data, 201) : commandError(c, result);
  });
  authed.patch("/plans/:id", async (c) => {
    const parsed = await body(c, planInputSchema);
    if (!parsed.ok) return parsed.response;
    const result = await updatePlan(c.get("adminDb"), ctxOf(c), c.req.param("id"), parsed.data);
    return result.ok ? c.json(result.data, 200) : commandError(c, result);
  });
  authed.delete("/plans/:id", async (c) => {
    const parsed = await body(c, deleteBody);
    if (!parsed.ok) return parsed.response;
    const result = await deletePlan(c.get("adminDb"), ctxOf(c), c.req.param("id"), parsed.data.reason);
    return result.ok ? c.json({ ok: true }, 200) : commandError(c, result);
  });

  // auditoria (somente leitura)
  authed.get("/audit", async (c) => {
    const q = query(c, auditQuery);
    if (!q.ok) return q.response;
    return c.json(await listAuditEntries(c.get("adminDb"), q.data), 200);
  });

  authed.onError((error, c) => {
    if (error instanceof AuditReasonError) return reply(c, 422, "validation_error", error.message);
    throw error;
  });

  app.route("/admin", authed);
  return app;
}
