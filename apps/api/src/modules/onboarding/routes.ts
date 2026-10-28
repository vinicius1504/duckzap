import { companyStepSchema, type CompanyStepInput } from "@duckzap/contracts/onboarding";
import { businessHoursSchema } from "@duckzap/contracts/settings";
import { schema, withOrg } from "@duckzap/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { AppBindings, Deps } from "../../lib/context";
import { requireAuth } from "../../middleware/require-auth";
import { parseBody, withActor, type ActorBindings } from "../team/http";
import { defaultBusinessHours, defaultServiceSettings, isValidTimeZone } from "../settings/defaults";
import { fromSettingsHours, toSettingsHours } from "./hours";

/** Período e plano do teste grátis. Valores comerciais `[A DEFINIR]` (§1.2); ajustar aqui. */
const TRIAL_PLAN = "pro";
const TRIAL_DAYS = 14;

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Passo "Empresa" do cadastro: nome, horário e fuso (a boas-vindas é legado opcional) (o fuso é opcional no front). */
const createOrganizationBody = companyStepSchema.extend({
  timeZone: z.string().min(1).max(64).default("America/Sao_Paulo"),
});

const createOrganizationRoute = createRoute({
  method: "post",
  path: "/onboarding/organization",
  tags: ["Cadastro"],
  summary: "Cria a empresa da pessoa logada (ela vira Proprietária) com assinatura de teste",
  request: { body: { content: { "application/json": { schema: createOrganizationBody } }, required: true } },
  responses: {
    201: {
      description: "Empresa criada",
      content: { "application/json": { schema: z.object({ organizationId: z.string() }) } },
    },
    401: { description: "Sem sessão", content: { "application/json": { schema: errorSchema } } },
    409: { description: "A pessoa já tem empresa", content: { "application/json": { schema: errorSchema } } },
    422: { description: "Dados inválidos", content: { "application/json": { schema: errorSchema } } },
  },
});

function slugify(name: string) {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "empresa"}-${uuidv7().slice(-6)}`;
}

/**
 *   POST /v1/onboarding/organization   cria empresa + Proprietária + teste grátis + horário e boas-vindas (sessão)
 *   GET  /v1/onboarding                rascunho: conta e, se já criada, os dados da empresa (sessão)
 *   PUT  /v1/onboarding/company        volta e edita o passo Empresa depois de criada (settings.manage)
 * O cadastro da conta em si é o do Better Auth: POST /v1/auth/sign-up/email (entra já logado).
 */
export function onboardingRoutes(deps: Deps) {
  const app = new OpenAPIHono<AppBindings>();
  app.use("/onboarding", requireAuth(deps));
  app.use("/onboarding/organization", requireAuth(deps));

  app.openapi(createOrganizationRoute, async (c) => {
    const { user } = c.get("authSession");
    const body = c.req.valid("json");
    if (!isValidTimeZone(body.timeZone)) {
      return c.json({ error: { code: "validation_error", message: "Fuso horário inválido." } }, 422);
    }

    const existing = await deps.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, user.id))
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: { code: "already_has_organization", message: "Sua conta já tem uma empresa." } }, 409);
    }

    // Better Auth cria a organização, o vínculo de Proprietária e marca como ativa na sessão
    const organization = await deps.auth.api.createOrganization({
      headers: c.req.raw.headers,
      body: { name: body.companyName, slug: slugify(body.companyName), timeZone: body.timeZone },
    });
    if (!organization) throw new Error("Falha ao criar a organização");

    const service = defaultServiceSettings();
    await withOrg(deps.db, organization.id, async (tx) => {
      await tx.insert(schema.subscriptions).values({
        id: uuidv7(),
        organizationId: organization.id,
        planSlug: TRIAL_PLAN,
        status: "trial",
        currentPeriodEnd: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
      });
      await tx.insert(schema.organizationSettings).values({
        organizationId: organization.id,
        businessHours: toSettingsHours(body.businessHours),
        welcomeMessage: body.welcomeMessage,
        followUp: service.followUp,
        inactivityClose: service.inactivityClose,
      });
    });

    return c.json({ organizationId: organization.id }, 201);
  });

  app.get("/onboarding", async (c) => {
    const { user } = c.get("authSession");
    const [membership] = await deps.db
      .select({ organizationId: schema.member.organizationId, name: schema.organization.name })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, user.id))
      .limit(1);

    let company: CompanyStepInput | null = null;
    if (membership) {
      const [row] = await withOrg(deps.db, membership.organizationId, (tx) =>
        tx.select().from(schema.organizationSettings).where(eq(schema.organizationSettings.organizationId, membership.organizationId)),
      );
      const hours = businessHoursSchema.safeParse(row?.businessHours);
      const candidate = companyStepSchema.safeParse({
        companyName: membership.name,
        businessHours: fromSettingsHours(hours.success ? hours.data : defaultBusinessHours()),
        welcomeMessage: row?.welcomeMessage ?? "",
      });
      // a boas-vindas deixou de ser obrigatória (conta nova é "Somente IA"): só nome e horário definem o passo
      company = candidate.success ? candidate.data : null;
    }
    return c.json({ account: { id: user.id, name: user.name, email: user.email }, company, hasOrganization: Boolean(membership) });
  });

  // edição do passo depois de criado: precisa de empresa e de permissão (a Proprietária recém-criada tem)
  const editor = new OpenAPIHono<ActorBindings>();
  editor.use("/onboarding/company", withActor(deps, "settings.manage"));
  editor.put("/onboarding/company", async (c) => {
    const body = await parseBody(c, companyStepSchema);
    if (!body.ok) return body.response;
    const { organizationId } = c.get("actor");
    await deps.db.update(schema.organization).set({ name: body.data.companyName }).where(eq(schema.organization.id, organizationId));
    await withOrg(deps.db, organizationId, async (tx) => {
      const service = defaultServiceSettings();
      const values = {
        businessHours: toSettingsHours(body.data.businessHours),
        welcomeMessage: body.data.welcomeMessage,
        updatedAt: new Date(),
      };
      await tx
        .insert(schema.organizationSettings)
        .values({ organizationId, ...values, followUp: service.followUp, inactivityClose: service.inactivityClose })
        .onConflictDoUpdate({ target: schema.organizationSettings.organizationId, set: values });
    });
    return c.json({ ok: true });
  });
  app.route("/", editor);

  return app;
}
