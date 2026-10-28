import type {
  ChangeCompanyPlanInput,
  Company,
  ExtendCompanyInput,
  Plan,
  PlanInput,
  SetCompanyEnabledInput,
} from "@duckzap/contracts/admin";
import { schema, type Database } from "@duckzap/db";
import { asc, eq, sql } from "drizzle-orm";
import { writeAudit, type AuditActor } from "./audit";
import {
  companyStatusOf,
  dateInPlatformTz,
  diffRecords,
  endOfDueDate,
  foldText,
  formatDay,
  formatPrice,
  slugify,
  storedStatusFor,
} from "./logic";
import { getCompany, getCompanyRow } from "./queries";

const { subscriptions, plans } = schema;

export type Ctx = { actor: AuditActor; ip: string | null };
export type CommandResult<T, E extends string> = { ok: true; data: T } | { ok: false; error: E; message: string };

const fail = <E extends string>(error: E, message: string) => ({ ok: false, error, message }) as const;
const ok = <T>(data: T) => ({ ok: true, data }) as const;

/* ───────────── empresas ───────────── */

type CompanyError = "not_found" | "invalid";

/** Trava a linha da assinatura até o fim da transação: duas mutações da mesma empresa não se atropelam. */
async function lockSubscription(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], companyId: string) {
  await tx.execute(sql`select 1 from subscriptions where organization_id = ${companyId} for update`);
}

export async function changeCompanyPlan(db: Database, ctx: Ctx, input: ChangeCompanyPlanInput): Promise<CommandResult<Company, CompanyError>> {
  return db.transaction(async (tx) => {
    await lockSubscription(tx, input.companyId);
    const row = await getCompanyRow(tx, input.companyId);
    if (!row) return fail("not_found", "Empresa não encontrada.");
    const [plan] = await tx.select().from(plans).where(eq(plans.slug, input.planId)).limit(1);
    if (!plan || !plan.active) return fail("invalid", "Escolha um plano ativo.");
    if (plan.slug === row.plan_slug) return fail("invalid", "A empresa já está neste plano.");

    await tx.update(subscriptions).set({ planSlug: plan.slug, updatedAt: new Date() }).where(eq(subscriptions.organizationId, row.id));
    await writeAudit(tx, {
      kind: "mutation",
      actor: ctx.actor,
      action: "company.plan_changed",
      target: { type: "company", id: row.id, name: row.name },
      company: { id: row.id, name: row.name },
      before: { planId: row.plan_slug, planName: row.plan_name },
      after: { planId: plan.slug, planName: plan.name },
      changes: [{ field: "Plano", from: row.plan_name, to: plan.name }],
      reason: input.reason,
      ip: ctx.ip,
    });
    const company = await getCompany(tx, row.id);
    return company ? ok(company) : fail("not_found", "Empresa não encontrada.");
  });
}

export async function extendCompany(db: Database, ctx: Ctx, input: ExtendCompanyInput, now = new Date()): Promise<CommandResult<Company, CompanyError>> {
  return db.transaction(async (tx) => {
    await lockSubscription(tx, input.companyId);
    const row = await getCompanyRow(tx, input.companyId);
    if (!row) return fail("not_found", "Empresa não encontrada.");
    const today = dateInPlatformTz(now);
    if (input.dueDate <= today) return fail("invalid", "O novo vencimento precisa ser depois de hoje.");
    if (input.dueDate <= row.due_date) return fail("invalid", "O novo vencimento precisa ser depois do atual.");

    const status = storedStatusFor(companyStatusOf({ enabled: row.enabled, onTrial: row.on_trial, dueDate: input.dueDate, today }));
    await tx
      .update(subscriptions)
      .set({ currentPeriodEnd: endOfDueDate(input.dueDate), status, updatedAt: now })
      .where(eq(subscriptions.organizationId, row.id));
    await writeAudit(tx, {
      kind: "mutation",
      actor: ctx.actor,
      action: "company.due_date_extended",
      target: { type: "company", id: row.id, name: row.name },
      company: { id: row.id, name: row.name },
      before: { dueDate: row.due_date },
      after: { dueDate: input.dueDate },
      changes: [{ field: row.on_trial ? "Fim do teste" : "Vencimento", from: formatDay(row.due_date), to: formatDay(input.dueDate) }],
      reason: input.reason,
      ip: ctx.ip,
    });
    const company = await getCompany(tx, row.id);
    return company ? ok(company) : fail("not_found", "Empresa não encontrada.");
  });
}

export async function setCompanyEnabled(db: Database, ctx: Ctx, input: SetCompanyEnabledInput, now = new Date()): Promise<CommandResult<Company, CompanyError>> {
  return db.transaction(async (tx) => {
    await lockSubscription(tx, input.companyId);
    const row = await getCompanyRow(tx, input.companyId);
    if (!row) return fail("not_found", "Empresa não encontrada.");
    if (row.enabled === input.enabled) {
      return fail("invalid", input.enabled ? "A empresa já está ativa." : "A empresa já está desativada.");
    }
    const status = storedStatusFor(
      companyStatusOf({ enabled: input.enabled, onTrial: row.on_trial, dueDate: row.due_date, today: dateInPlatformTz(now) }),
    );
    await tx
      .update(subscriptions)
      .set({ disabledAt: input.enabled ? null : now, status, updatedAt: now })
      .where(eq(subscriptions.organizationId, row.id));
    await writeAudit(tx, {
      kind: "mutation",
      actor: ctx.actor,
      action: input.enabled ? "company.enabled" : "company.disabled",
      target: { type: "company", id: row.id, name: row.name },
      company: { id: row.id, name: row.name },
      before: { enabled: row.enabled },
      after: { enabled: input.enabled },
      changes: [{ field: "Situação", from: input.enabled ? "Desativada" : "Ativa", to: input.enabled ? "Ativa" : "Desativada" }],
      reason: input.reason,
      ip: ctx.ip,
    });
    const company = await getCompany(tx, row.id);
    return company ? ok(company) : fail("not_found", "Empresa não encontrada.");
  });
}

/* ───────────── planos ───────────── */

const FEATURE_KEYS = ["campaigns", "instagram", "copilot"] as const;
const FEATURE_LABELS = { campaigns: "Campanhas", instagram: "Instagram", copilot: "Copiloto" } as const;

type PlanRow = typeof plans.$inferSelect;
type PlanFields = Omit<PlanInput, "reason">;

export function toPlan(row: PlanRow, companiesCount: number): Plan {
  return {
    id: row.slug,
    name: row.name,
    firstMonthPriceCents: row.firstMonthPriceCents,
    recurringPriceCents: row.recurringPriceCents,
    limits: { channels: row.maxChannels, users: row.maxUsers, agents: row.maxAgents },
    features: {
      campaigns: row.features.includes("campaigns"),
      instagram: row.features.includes("instagram"),
      copilot: row.features.includes("copilot"),
    },
    checkoutUrl: row.checkoutUrl,
    active: row.active,
    companiesCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function fieldsOf(plan: Plan | PlanFields): PlanFields {
  return {
    name: plan.name,
    firstMonthPriceCents: plan.firstMonthPriceCents,
    recurringPriceCents: plan.recurringPriceCents,
    limits: plan.limits,
    features: plan.features,
    checkoutUrl: plan.checkoutUrl,
    active: plan.active,
  };
}

/** Retrato em texto de exibição (usado para o antes→depois da auditoria). */
function describePlan(plan: PlanFields): Record<string, string> {
  return {
    Nome: plan.name,
    "1º mês": formatPrice(plan.firstMonthPriceCents),
    "Meses seguintes": formatPrice(plan.recurringPriceCents),
    Canais: String(plan.limits.channels),
    Usuários: String(plan.limits.users),
    Agentes: plan.limits.agents === null ? "Ilimitados" : String(plan.limits.agents),
    ...Object.fromEntries(FEATURE_KEYS.map((key) => [FEATURE_LABELS[key], plan.features[key] ? "Sim" : "Não"])),
    Checkout: plan.checkoutUrl ?? "[LINK]",
    Status: plan.active ? "Ativo" : "Inativo",
  };
}

async function companiesCountByPlan(db: Pick<Database, "execute">) {
  const rows = await db.execute<{ plan_slug: string; n: number }>(sql`select plan_slug, count(*)::int as n from subscriptions group by plan_slug`);
  return new Map(rows.map((r) => [r.plan_slug, r.n]));
}

export async function listPlans(db: Database): Promise<Plan[]> {
  const [rows, counts] = await Promise.all([db.select().from(plans).orderBy(asc(plans.createdAt), asc(plans.slug)), companiesCountByPlan(db)]);
  return rows.map((row) => toPlan(row, counts.get(row.slug) ?? 0));
}

function featureList(existing: string[], flags: PlanFields["features"]) {
  // preserva chaves desconhecidas que outro módulo possa ter gravado
  const known = new Set<string>(FEATURE_KEYS);
  return [...existing.filter((f) => !known.has(f)), ...FEATURE_KEYS.filter((key) => flags[key])];
}

const normalizeName = (name: string) => foldText(name.trim());

export async function createPlan(db: Database, ctx: Ctx, input: PlanInput): Promise<CommandResult<Plan, "duplicate">> {
  const { reason, ...fields } = input;
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(plans);
    if (existing.some((p) => normalizeName(p.name) === normalizeName(fields.name))) {
      return fail("duplicate", "Já existe um plano com esse nome.");
    }
    const base = slugify(fields.name) || "plano";
    let slug = base;
    for (let n = 2; existing.some((p) => p.slug === slug); n++) slug = `${base}-${n}`;

    const [row] = await tx
      .insert(plans)
      .values({
        slug,
        name: fields.name,
        maxChannels: fields.limits.channels,
        maxUsers: fields.limits.users,
        maxAgents: fields.limits.agents,
        features: featureList([], fields.features),
        firstMonthPriceCents: fields.firstMonthPriceCents,
        recurringPriceCents: fields.recurringPriceCents,
        checkoutUrl: fields.checkoutUrl,
        active: fields.active,
      })
      .returning();
    if (!row) throw new Error("plano não foi criado");
    const plan = toPlan(row, 0);
    await writeAudit(tx, {
      kind: "mutation",
      actor: ctx.actor,
      action: "plan.created",
      target: { type: "plan", id: slug, name: plan.name },
      company: null,
      before: null,
      after: fieldsOf(plan),
      changes: Object.entries(describePlan(fields)).map(([field, to]) => ({ field, from: null, to })),
      reason,
      ip: ctx.ip,
    });
    return ok(plan);
  });
}

export async function updatePlan(db: Database, ctx: Ctx, id: string, input: PlanInput): Promise<CommandResult<Plan, "not_found" | "duplicate" | "unchanged">> {
  const { reason, ...fields } = input;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(plans).where(eq(plans.slug, id)).for("update").limit(1);
    if (!current) return fail("not_found", "Plano não encontrado.");
    const others = await tx.select().from(plans);
    if (others.some((p) => p.slug !== id && normalizeName(p.name) === normalizeName(fields.name))) {
      return fail("duplicate", "Já existe um plano com esse nome.");
    }
    const counts = await companiesCountByPlan(tx);
    const before = toPlan(current, counts.get(id) ?? 0);
    const changes = diffRecords(describePlan(fieldsOf(before)), describePlan(fields));
    if (changes.length === 0) return fail("unchanged", "Nada mudou neste plano.");

    const [row] = await tx
      .update(plans)
      .set({
        name: fields.name,
        maxChannels: fields.limits.channels,
        maxUsers: fields.limits.users,
        maxAgents: fields.limits.agents,
        features: featureList(current.features, fields.features),
        firstMonthPriceCents: fields.firstMonthPriceCents,
        recurringPriceCents: fields.recurringPriceCents,
        checkoutUrl: fields.checkoutUrl,
        active: fields.active,
      })
      .where(eq(plans.slug, id))
      .returning();
    if (!row) throw new Error("plano não foi atualizado");
    const plan = toPlan(row, before.companiesCount);
    await writeAudit(tx, {
      kind: "mutation",
      actor: ctx.actor,
      action: "plan.updated",
      target: { type: "plan", id, name: plan.name },
      company: null,
      before: fieldsOf(before),
      after: fieldsOf(plan),
      changes,
      reason,
      ip: ctx.ip,
    });
    return ok(plan);
  });
}

export async function deletePlan(db: Database, ctx: Ctx, id: string, reason: string): Promise<CommandResult<null, "not_found" | "in_use">> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(plans).where(eq(plans.slug, id)).for("update").limit(1);
    if (!current) return fail("not_found", "Plano não encontrado.");
    const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from subscriptions where plan_slug = ${id}`);
    if (n > 0) {
      return fail("in_use", `${n} ${n === 1 ? "empresa usa" : "empresas usam"} este plano. Desative em vez de excluir.`);
    }
    // a auditoria entra ANTES do delete na mesma transação: sem motivo válido, nada é apagado
    await writeAudit(tx, {
      kind: "mutation",
      actor: ctx.actor,
      action: "plan.deleted",
      target: { type: "plan", id, name: current.name },
      company: null,
      before: fieldsOf(toPlan(current, 0)),
      after: null,
      changes: [{ field: "Plano", from: current.name, to: null }],
      reason,
      ip: ctx.ip,
    });
    await tx.delete(plans).where(eq(plans.slug, id));
    return ok(null);
  });
}
