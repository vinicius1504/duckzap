import type { CatalogPlanSlug, PlanSlug } from "@duckzap/contracts/session";
import { planSlugSchema } from "@duckzap/contracts/session";
import {
  businessHoursSchema,
  serviceSettingsSchema,
  type Billing,
  type Company,
  type Integrations,
  type Plan,
  type ServiceSettings,
  type UpdateCompanyInput,
} from "@duckzap/contracts/settings";
import { schema, withOrg, type Transaction } from "@duckzap/db";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { encryptSecret, lastFour } from "../../lib/crypto";
import type { Deps } from "../../lib/context";
import type { Actor } from "../team/http";
import { countUsers } from "../team/queries";
import { errRes, okRes, type Res } from "../team/result";
import { defaultBusinessHours, defaultServiceSettings, isValidTimeZone } from "./defaults";

type Ctx = { deps: Deps; actor: Actor };

// ---------- Empresa ----------

async function loadSettingsRow(tx: Transaction, organizationId: string) {
  const [row] = await tx.select().from(schema.organizationSettings).where(eq(schema.organizationSettings.organizationId, organizationId));
  return row ?? null;
}

export async function getCompany({ deps, actor }: Ctx): Promise<Company> {
  const org = actor.organizationId;
  const [organization] = await deps.db.select().from(schema.organization).where(eq(schema.organization.id, org));
  const row = await withOrg(deps.db, org, (tx) => loadSettingsRow(tx, org));
  const hours = businessHoursSchema.safeParse(row?.businessHours);
  return {
    name: organization?.name ?? "",
    segment: row?.segment ?? "",
    phone: row?.phone ?? "",
    email: row?.email ?? "",
    logoUrl: organization?.logo ?? null,
    timeZone: organization?.timeZone ?? "America/Sao_Paulo",
    businessHours: hours.success ? hours.data : defaultBusinessHours(),
  };
}

export async function updateCompany(ctx: Ctx, input: UpdateCompanyInput): Promise<Res<Company>> {
  const { deps, actor } = ctx;
  const org = actor.organizationId;
  if (!isValidTimeZone(input.timeZone)) return errRes(422, "validation_error", "Fuso horário inválido.");
  // `organization` é do Better Auth (sem RLS): o filtro por id da sessão é explícito
  await deps.db.update(schema.organization).set({ name: input.name, timeZone: input.timeZone }).where(eq(schema.organization.id, org));
  await withOrg(deps.db, org, async (tx) => {
    const values = {
      segment: input.segment,
      phone: input.phone,
      email: input.email,
      businessHours: input.businessHours,
      updatedAt: new Date(),
    };
    const service = defaultServiceSettings();
    await tx
      .insert(schema.organizationSettings)
      .values({ organizationId: org, ...values, followUp: service.followUp, inactivityClose: service.inactivityClose })
      .onConflictDoUpdate({ target: schema.organizationSettings.organizationId, set: values });
  });
  return okRes(await getCompany(ctx));
}

// ---------- Atendimento ----------

export async function getServiceSettings({ deps, actor }: Ctx): Promise<ServiceSettings> {
  const org = actor.organizationId;
  const row = await withOrg(deps.db, org, (tx) => loadSettingsRow(tx, org));
  const parsed = serviceSettingsSchema.safeParse({ followUp: row?.followUp, inactivityClose: row?.inactivityClose });
  return parsed.success ? parsed.data : defaultServiceSettings();
}

export async function updateServiceSettings({ deps, actor }: Ctx, input: ServiceSettings): Promise<ServiceSettings> {
  const org = actor.organizationId;
  await withOrg(deps.db, org, async (tx) => {
    await tx
      .insert(schema.organizationSettings)
      .values({
        organizationId: org,
        businessHours: defaultBusinessHours(),
        followUp: input.followUp,
        inactivityClose: input.inactivityClose,
      })
      .onConflictDoUpdate({
        target: schema.organizationSettings.organizationId,
        set: { followUp: input.followUp, inactivityClose: input.inactivityClose, updatedAt: new Date() },
      });
  });
  return input;
}

// ---------- Integrações (máquina de estados; OAuth real fica para depois) ----------

type Provider = "google_calendar" | "instagram" | "whatsapp_official";

async function loadIntegration(tx: Transaction, organizationId: string, provider: Provider) {
  const [row] = await tx
    .select()
    .from(schema.integrations)
    .where(sql`${schema.integrations.organizationId} = ${organizationId} and ${schema.integrations.provider} = ${provider}`);
  return row ?? null;
}

async function saveIntegration(
  tx: Transaction,
  organizationId: string,
  provider: Provider,
  values: Partial<typeof schema.integrations.$inferInsert>,
) {
  await tx
    .insert(schema.integrations)
    .values({ id: uuidv7(), organizationId, provider, ...values })
    .onConflictDoUpdate({
      target: [schema.integrations.organizationId, schema.integrations.provider],
      set: { ...values, updatedAt: new Date() },
    });
}

type IntegrationStatus = Integrations["googleCalendar"]["status"];
const asStatus = (value: string | undefined): IntegrationStatus =>
  value === "connected" || value === "awaiting_authorization" || value === "error" ? value : "disconnected";

export async function getIntegrations({ deps, actor }: Ctx): Promise<Integrations> {
  const org = actor.organizationId;
  return withOrg(deps.db, org, async (tx) => {
    const [google, instagram] = await Promise.all([loadIntegration(tx, org, "google_calendar"), loadIntegration(tx, org, "instagram")]);
    let official = await loadIntegration(tx, org, "whatsapp_official");
    if (!official?.verifyToken) {
      // o token de verificação do webhook de entrada nasce na primeira leitura
      await saveIntegration(tx, org, "whatsapp_official", { verifyToken: `dz_verify_${randomBytes(9).toString("base64url")}` });
      official = await loadIntegration(tx, org, "whatsapp_official");
    }
    return {
      googleCalendar: {
        status: asStatus(google?.status),
        calendarName: google?.displayName ?? null,
        lastSyncAt: google?.lastSyncAt?.toISOString() ?? null,
      },
      instagram: { status: asStatus(instagram?.status), account: instagram?.displayName ?? null },
      whatsappOfficial: {
        status: asStatus(official?.status),
        phoneNumberIdLast4: official?.phoneNumberIdLast4 ?? null,
        accessTokenLast4: official?.secretLast4 ?? null,
        // endereço que a Meta chama; o handler real pertence ao módulo Canais (alinhar na integração)
        webhookUrl: `${deps.env.PUBLIC_API_URL}/v1/webhooks/whatsapp/${org}`,
        verifyToken: official?.verifyToken ?? "",
      },
    };
  });
}

/** Sem OAuth real: marca como conectada, com o nome da empresa como agenda. */
export async function connectGoogleCalendar({ deps, actor }: Ctx): Promise<void> {
  const org = actor.organizationId;
  const [organization] = await deps.db.select({ name: schema.organization.name }).from(schema.organization).where(eq(schema.organization.id, org));
  await withOrg(deps.db, org, (tx) =>
    saveIntegration(tx, org, "google_calendar", {
      status: "connected",
      displayName: (organization?.name ?? "").split(" ").slice(0, 2).join(" ") || null,
      lastSyncAt: new Date(),
    }),
  );
}

export async function disconnectGoogleCalendar({ deps, actor }: Ctx): Promise<void> {
  const org = actor.organizationId;
  await withOrg(deps.db, org, (tx) => saveIntegration(tx, org, "google_calendar", { status: "disconnected", displayName: null, lastSyncAt: null }));
}

/** Instagram: só autoriza quando o canal já pediu autorização (o canal vive em Canais). */
export async function authorizeInstagram({ deps, actor }: Ctx): Promise<Res<null>> {
  const org = actor.organizationId;
  return withOrg(deps.db, org, async (tx): Promise<Res<null>> => {
    const row = await loadIntegration(tx, org, "instagram");
    if (!row || row.status === "disconnected") return errRes(409, "no_channel", "Crie um canal do Instagram em Canais primeiro.");
    if (row.status === "awaiting_authorization") await saveIntegration(tx, org, "instagram", { status: "connected" });
    return okRes(null);
  });
}

/** Troca o token da API oficial: cifrado em repouso, só os últimos 4 voltam. A Meta não é chamada nesta fase. */
export async function updateWhatsappOfficialToken({ deps, actor }: Ctx, accessToken: string): Promise<Res<null>> {
  const org = actor.organizationId;
  const token = accessToken.trim();
  if (token.length < 20) return errRes(422, "invalid_credentials", "Cole o token de acesso completo.");
  await withOrg(deps.db, org, (tx) =>
    saveIntegration(tx, org, "whatsapp_official", {
      status: "connected",
      secretEncrypted: encryptSecret(org, token),
      secretLast4: lastFour(token),
    }),
  );
  return okRes(null);
}

// ---------- Planos e cobrança ----------

const knownFeatures = ["campaigns", "instagram", "copilot"] as const;

export async function listPlans(deps: Deps): Promise<Plan[]> {
  const rows = await deps.db.select().from(schema.plans).where(eq(schema.plans.active, true));
  const order: Record<CatalogPlanSlug, number> = { basico: 0, pro: 1, empresarial: 2 };
  return rows
    .flatMap((row): Plan[] => {
      const slug = planSlugSchema.safeParse(row.slug);
      if (!slug.success) return [];
      return [
        {
          slug: slug.data,
          name: row.name,
          priceCents: row.recurringPriceCents,
          limits: { channels: row.maxChannels, users: row.maxUsers, agents: row.maxAgents },
          features: knownFeatures.filter((f) => row.features.includes(f)),
        },
      ];
    })
    .sort((a, b) => order[a.slug] - order[b.slug]);
}

/** Conta linhas de uma tabela de outro módulo só se ela já existir (ainda não há migration de Canais/Agentes). */
async function countIfTableExists(tx: Transaction, table: "channels" | "agents"): Promise<number> {
  const exists = await tx.execute<{ ok: boolean }>(sql`select to_regclass(${`public.${table}`}) is not null as ok`);
  if (!exists[0]?.ok) return 0;
  const rows = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`);
  return rows[0]?.n ?? 0;
}

export async function getUsage(tx: Transaction, organizationId: string) {
  const [users, channels, agents] = await Promise.all([
    countUsers(tx, organizationId),
    countIfTableExists(tx, "channels"),
    countIfTableExists(tx, "agents"),
  ]);
  return { channels, users, agents };
}

export async function getBilling({ deps, actor }: Ctx): Promise<Billing> {
  const org = actor.organizationId;
  const plans = await listPlans(deps);
  const { usage, subscription } = await withOrg(deps.db, org, async (tx) => {
    const [sub] = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.organizationId, org));
    return { usage: await getUsage(tx, org), subscription: sub ?? null };
  });
  const status = subscription?.status;
  return {
    plans,
    // a tela de cobrança só conhece os 3 planos de catálogo; plano personalizado aparece como o mais próximo (Básico)
    currentPlan: planSlugSchema.catch("basico").parse(actor.plan),
    renewsAt: (subscription?.currentPeriodEnd ?? new Date()).toISOString().slice(0, 10),
    paymentOk: status === "active" || status === "trial",
    usage,
    invoices: [], // cobrança real (gateway) ainda não existe
  };
}

/** Mudar para um plano só se o uso atual couber nos limites dele (downgrade acima do uso é recusado). */
export function overLimitMessage(usage: Billing["usage"], target: Pick<Plan, "name" | "limits">): string | null {
  const over: string[] = [];
  if (target.limits.channels !== null && usage.channels > target.limits.channels)
    over.push(`${usage.channels} canais (limite ${target.limits.channels})`);
  if (target.limits.users !== null && usage.users > target.limits.users)
    over.push(`${usage.users} usuários (limite ${target.limits.users})`);
  if (target.limits.agents !== null && usage.agents > target.limits.agents)
    over.push(`${usage.agents} agentes (limite ${target.limits.agents})`);
  return over.length ? `Para mudar para o ${target.name}, reduza antes: ${over.join(", ")}.` : null;
}

/** Upgrade devolve o link de pagamento (`[LINK]` até o checkout existir); downgrade só se o uso couber. */
export async function requestPlanChange(ctx: Ctx, slug: PlanSlug): Promise<Res<{ checkoutUrl: string }>> {
  const billing = await getBilling(ctx);
  if (billing.currentPlan === slug) return errRes(409, "same_plan", "Este já é o seu plano.");
  const target = billing.plans.find((p) => p.slug === slug);
  if (!target) return errRes(404, "not_found", "Plano não encontrado.");
  const over = overLimitMessage(billing.usage, target);
  if (over) return errRes(409, "over_limit", over);
  return okRes({ checkoutUrl: "[LINK]" });
}
