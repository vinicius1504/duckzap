import type {
  AuditEntry,
  AuditListQuery,
  Company,
  CompanyCounts,
  CompanyListQuery,
  Invoice,
  Paginated,
  PlatformOverview,
  Subscription,
  SubscriptionCounts,
  SubscriptionListQuery,
} from "@duckzap/contracts/admin";
import { schema } from "@duckzap/db";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Executor } from "./audit";
import {
  addDaysIso,
  dateInPlatformTz,
  foldText,
  OVERDUE_MAX_DAYS,
  PAST_DUE_MAX_DAYS,
  type CompanyStatus,
} from "./logic";

export const COMPANIES_PAGE_SIZE = 10;
export const SUBSCRIPTIONS_PAGE_SIZE = 10;
export const AUDIT_PAGE_SIZE = 15;

const TZ = "'America/Sao_Paulo'";

/* ───────────── uso por empresa (tolera tabelas que ainda não existem) ───────────── */

type UsageSql = { channels: SQL; agents: SQL };
let usageCache: { at: number; value: UsageSql } | null = null;

async function optionalCount(db: Executor, table: string): Promise<SQL> {
  try {
    const [row] = await db.execute<{ ok: boolean }>(sql`
      select case when to_regclass(${`public.${table}`}) is null then false
        else has_column_privilege(current_user, to_regclass(${`public.${table}`}), 'organization_id', 'select') end as ok`);
    if (row?.ok) return sql.raw(`(select count(*)::int from public."${table}" t where t.organization_id = o.id)`);
  } catch {
    // tabela sem a coluna: trata como inexistente
  }
  return sql.raw("0");
}

/** Canais/agentes: conta só se a tabela existe e o papel admin pode ler `organization_id`; senão, 0. Revalidado a cada minuto. */
async function usageSql(db: Executor): Promise<UsageSql> {
  if (usageCache && Date.now() - usageCache.at < 60_000) return usageCache.value;
  const value = { channels: await optionalCount(db, "channels"), agents: await optionalCount(db, "agents") };
  usageCache = { at: Date.now(), value };
  return value;
}

/* ───────────── empresas: CTE única (status calculado no banco) ───────────── */

/** Mesma regra de `companyStatusOf` (logic.ts), em SQL, para filtrar e contar sem trazer tudo para a memória. */
const STATUS_CASE = sql.raw(`case
  when not enabled then 'disabled'
  when late_days <= 0 then (case when on_trial then 'trial' else 'active' end)
  when late_days <= ${OVERDUE_MAX_DAYS} then 'overdue'
  when late_days <= ${PAST_DUE_MAX_DAYS} then 'past_due'
  else 'expired' end`);

const iso = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

function companiesCte(usage: UsageSql): SQL {
  return sql`with base as (
    select o.id, o.name, o.slug, o.metadata,
      ${iso("o.created_at")} as created_at,
      s.id as sub_id, s.plan_slug, p.name as plan_name, p.recurring_price_cents,
      s.on_trial, (s.disabled_at is null) as enabled, s.cycle, s.gateway, s.gateway_reference,
      ${iso("s.created_at")} as sub_created_at,
      to_char((s.current_period_end at time zone ${sql.raw(TZ)})::date, 'YYYY-MM-DD') as due_date,
      ((now() at time zone ${sql.raw(TZ)})::date - (s.current_period_end at time zone ${sql.raw(TZ)})::date) as late_days,
      ow.name as owner_name, ow.email as owner_email,
      (select count(*)::int from member m where m.organization_id = o.id) as users,
      ${usage.channels} as channels,
      ${usage.agents} as agents
    from organization o
    join subscriptions s on s.organization_id = o.id
    join plans p on p.slug = s.plan_slug
    left join lateral (
      select u.name, u.email from member m join "user" u on u.id = m.user_id
      where m.organization_id = o.id order by (m.role = 'owner') desc, m.created_at asc limit 1
    ) ow on true
  ), c as (select base.*, ${STATUS_CASE} as status from base)`;
}

export type CompanyDbRow = {
  id: string;
  name: string;
  slug: string;
  metadata: string | null;
  created_at: string;
  sub_id: string;
  plan_slug: string;
  plan_name: string;
  recurring_price_cents: number | null;
  on_trial: boolean;
  enabled: boolean;
  cycle: "monthly" | "yearly";
  gateway: string | null;
  gateway_reference: string | null;
  sub_created_at: string;
  due_date: string;
  late_days: number;
  owner_name: string | null;
  owner_email: string | null;
  users: number;
  channels: number;
  agents: number;
  status: CompanyStatus;
};

/** Perfil da empresa guardado em `organization.metadata` (JSON do Better Auth) pelo onboarding; ausente => vazio. */
function profileOf(metadata: string | null) {
  const empty = { document: "", phone: "", city: "", segment: "" };
  if (!metadata) return empty;
  try {
    const data: unknown = JSON.parse(metadata);
    if (typeof data !== "object" || data === null) return empty;
    const record = data as Record<string, unknown>;
    const text = (...keys: string[]) => {
      for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
      return "";
    };
    return {
      document: text("document", "cnpj").replace(/\D/g, ""),
      phone: text("phone", "whatsapp"),
      city: text("city"),
      segment: text("segment"),
    };
  } catch {
    return empty;
  }
}

export function toCompany(row: CompanyDbRow): Company {
  return {
    id: row.id,
    name: row.name,
    ownerName: row.owner_name ?? "",
    email: row.owner_email ?? "sem-responsavel@example.invalid",
    ...profileOf(row.metadata),
    planId: row.plan_slug,
    planName: row.plan_name,
    onTrial: row.on_trial,
    dueDate: row.due_date,
    status: row.status,
    daysPastDue: row.late_days > 0 ? row.late_days : null,
    enabled: row.enabled,
    usage: { channels: row.channels, users: row.users, agents: row.agents },
    createdAt: row.created_at,
  };
}

const SUBSCRIPTION_STATUS: Record<CompanyStatus, Subscription["status"]> = {
  active: "active",
  trial: "trial",
  overdue: "overdue",
  past_due: "past_due",
  expired: "expired",
  disabled: "canceled",
};

export function toSubscription(row: CompanyDbRow): Subscription {
  const monthly = row.recurring_price_cents;
  return {
    id: row.sub_id,
    companyId: row.id,
    companyName: row.name,
    planId: row.plan_slug,
    planName: row.plan_name,
    onTrial: row.on_trial,
    amountCents: row.on_trial ? 0 : monthly === null ? null : row.cycle === "yearly" ? monthly * 12 : monthly,
    cycle: row.cycle,
    nextDueDate: row.due_date,
    status: SUBSCRIPTION_STATUS[row.status],
    daysPastDue: row.late_days > 0 ? row.late_days : null,
    gateway: row.gateway,
    gatewayReference: row.gateway_reference,
    startedAt: row.sub_created_at,
  };
}

const fold = (column: string) =>
  sql.raw(`translate(lower(coalesce(${column}, '')), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`);

/** Padrão LIKE seguro (escape com '!') sobre o texto sem acento e sem caixa. */
function likePattern(search: string) {
  return `%${foldText(search.trim()).replace(/[!%_]/g, (m) => `!${m}`)}%`;
}

function searchClause(search: string, columns: string[]): SQL | null {
  if (!search.trim()) return null;
  const pattern = likePattern(search);
  return sql`(${sql.join(
    columns.map((column) => sql`${fold(column)} like ${pattern} escape '!'`),
    sql` or `,
  )})`;
}

function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function clampPage(page: number, total: number, pageSize: number) {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / pageSize)));
}

const whereAll = (parts: (SQL | null)[]): SQL => {
  const list = parts.filter((p): p is SQL => p !== null);
  return list.length ? sql`where ${sql.join(list, sql` and `)}` : sql``;
};

/* ───────────── empresas ───────────── */

export async function listCompanies(db: Executor, query: CompanyListQuery): Promise<Paginated<Company>> {
  const cte = companiesCte(await usageSql(db));
  const where = whereAll([
    query.filter === "all" ? null : sql`status = ${query.filter}`,
    searchClause(query.search, ["name", "owner_name", "owner_email", "slug"]),
  ]);
  const [{ n: total = 0 } = { n: 0 }] = await db.execute<{ n: number }>(sql`${cte} select count(*)::int as n from c ${where}`);
  const page = clampPage(query.page, total, COMPANIES_PAGE_SIZE);
  const rows = await db.execute<CompanyDbRow>(
    sql`${cte} select * from c ${where} order by lower(name) asc, id asc limit ${COMPANIES_PAGE_SIZE} offset ${(page - 1) * COMPANIES_PAGE_SIZE}`,
  );
  return paginate(rows.map(toCompany), total, page, COMPANIES_PAGE_SIZE);
}

export async function getCompanyCounts(db: Executor): Promise<CompanyCounts> {
  const cte = companiesCte(await usageSql(db));
  const rows = await db.execute<{ status: CompanyStatus; n: number }>(sql`${cte} select status, count(*)::int as n from c group by status`);
  const by = (status: CompanyStatus) => rows.find((r) => r.status === status)?.n ?? 0;
  return {
    all: rows.reduce((sum, r) => sum + r.n, 0),
    active: by("active"),
    trial: by("trial"),
    overdue: by("overdue"),
    past_due: by("past_due"),
    expired: by("expired"),
  };
}

export async function getCompanyRow(db: Executor, id: string): Promise<CompanyDbRow | null> {
  const cte = companiesCte(await usageSql(db));
  const [row] = await db.execute<CompanyDbRow>(sql`${cte} select * from c where id = ${id} limit 1`);
  return row ?? null;
}

export async function getCompany(db: Executor, id: string): Promise<Company | null> {
  const row = await getCompanyRow(db, id);
  return row ? toCompany(row) : null;
}

export async function getCompanyDetail(db: Executor, id: string) {
  const row = await getCompanyRow(db, id);
  if (!row) return null;
  const [invoices, history] = await Promise.all([listInvoices(db, row.sub_id, 4), listAuditEntries(db, { filter: "all", search: "", companyId: id, page: 1 }, 5)]);
  return { company: toCompany(row), subscriptionId: row.sub_id, invoices, history: history.items };
}

/* ───────────── assinaturas e faturas ───────────── */

const LATE_FIRST: Record<Subscription["status"], number> = { past_due: 0, overdue: 1, expired: 2, trial: 3, active: 4, canceled: 5 };

function subscriptionFilter(filter: SubscriptionListQuery["filter"]): SQL | null {
  switch (filter) {
    case "all":
      return null;
    case "late":
      return sql`status in ('overdue','past_due')`;
    case "canceled":
      return sql`status = 'disabled'`;
    default:
      return sql`status = ${filter}`;
  }
}

export async function listSubscriptions(db: Executor, query: SubscriptionListQuery): Promise<Paginated<Subscription>> {
  const cte = companiesCte(await usageSql(db));
  const where = whereAll([subscriptionFilter(query.filter), searchClause(query.search, ["name", "plan_name"])]);
  const [{ n: total = 0 } = { n: 0 }] = await db.execute<{ n: number }>(sql`${cte} select count(*)::int as n from c ${where}`);
  const page = clampPage(query.page, total, SUBSCRIPTIONS_PAGE_SIZE);
  const rank = sql.raw(
    `case status when 'past_due' then ${LATE_FIRST.past_due} when 'overdue' then ${LATE_FIRST.overdue} when 'expired' then ${LATE_FIRST.expired} when 'trial' then ${LATE_FIRST.trial} when 'active' then ${LATE_FIRST.active} else ${LATE_FIRST.canceled} end`,
  );
  const rows = await db.execute<CompanyDbRow>(
    sql`${cte} select * from c ${where} order by ${rank} asc, due_date asc, id asc limit ${SUBSCRIPTIONS_PAGE_SIZE} offset ${(page - 1) * SUBSCRIPTIONS_PAGE_SIZE}`,
  );
  return paginate(rows.map(toSubscription), total, page, SUBSCRIPTIONS_PAGE_SIZE);
}

export async function getSubscriptionCounts(db: Executor): Promise<SubscriptionCounts> {
  const cte = companiesCte(await usageSql(db));
  const rows = await db.execute<{ status: CompanyStatus; n: number }>(sql`${cte} select status, count(*)::int as n from c group by status`);
  const by = (...statuses: CompanyStatus[]) => rows.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.n, 0);
  return {
    all: by("active", "trial", "overdue", "past_due", "expired", "disabled"),
    active: by("active"),
    trial: by("trial"),
    late: by("overdue", "past_due"),
    expired: by("expired"),
    canceled: by("disabled"),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getSubscription(db: Executor, id: string): Promise<Subscription | null> {
  if (!UUID.test(id)) return null;
  const cte = companiesCte(await usageSql(db));
  const [row] = await db.execute<CompanyDbRow>(sql`${cte} select * from c where sub_id = ${id} limit 1`);
  return row ? toSubscription(row) : null;
}

export async function listInvoices(db: Executor, subscriptionId: string, limit = 24): Promise<Invoice[]> {
  if (!UUID.test(subscriptionId)) return [];
  const { invoices } = schema;
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, subscriptionId))
    .orderBy(desc(invoices.dueDate))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    number: row.number,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
    status: row.status as Invoice["status"],
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    method: row.method as Invoice["method"],
  }));
}

/* ───────────── auditoria (leitura) ───────────── */

export async function listAuditEntries(db: Executor, query: AuditListQuery, pageSize = AUDIT_PAGE_SIZE): Promise<Paginated<AuditEntry>> {
  const { auditLogs } = schema;
  const parts: (SQL | undefined)[] = [
    // eventos de login/saída ficam no banco mas não aparecem nesta tela
    eq(auditLogs.kind, "mutation"),
    query.filter === "all" ? undefined : eq(auditLogs.targetType, query.filter === "companies" ? "company" : "plan"),
    query.companyId ? eq(auditLogs.companyId, query.companyId) : undefined,
  ];
  const search = searchClause(query.search, ["actor_name", "actor_email", "target_name", "company_name", "reason"]);
  if (search) parts.push(search);
  const where = and(...parts);

  const [{ n: total = 0 } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(where);
  const page = clampPage(query.page, total, pageSize);
  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.at), desc(auditLogs.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const items = rows.map(
    (row): AuditEntry => ({
      id: row.id,
      at: row.at.toISOString(),
      actor: { id: row.actorId ?? "", name: row.actorName, email: row.actorEmail },
      action: row.action as AuditEntry["action"],
      target: { type: row.targetType === "plan" ? "plan" : "company", id: row.targetId, name: row.targetName },
      company: row.companyId ? { id: row.companyId, name: row.companyName ?? "" } : null,
      changes: row.changes,
      reason: row.reason,
      ip: row.ip,
    }),
  );
  return paginate(items, total, page, pageSize);
}

/* ───────────── visão geral ───────────── */

const MONTHS = 6;
const WEEKS = 8;

function mondayOf(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDaysIso(date, -((day + 6) % 7));
}

export async function getPlatformOverview(db: Executor, now = new Date()): Promise<PlatformOverview> {
  const cte = companiesCte(await usageSql(db));
  const today = dateInPlatformTz(now);

  const rows = await db.execute<CompanyDbRow>(sql`${cte} select * from c`);
  const companies = rows.map((row) => ({ row, company: toCompany(row) }));

  // MRR estimado: empresas pagantes (ativas, fora de teste, não expiradas) × preço recorrente do plano
  const paying = companies.filter(({ company }) => company.enabled && !company.onTrial && company.status !== "expired");
  const prices = paying.map(({ row }) => row.recurring_price_cents);
  const estimated = prices.some((p) => p === null) ? null : prices.reduce<number>((sum, p) => sum + (p ?? 0), 0);

  // MRR dos últimos meses: faturas pagas (anuais divididas por 12)
  const firstMonth = `${today.slice(0, 7)}-01`;
  const monthKeys = Array.from({ length: MONTHS }, (_, i) => {
    const [y, m] = firstMonth.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 - (MONTHS - 1 - i), 1, 12));
    return d.toISOString().slice(0, 7);
  });
  const invoiceRows = await db.execute<{ month: string; mrr: number; paying: number }>(sql`
    select to_char(date_trunc('month', i.due_date::timestamp), 'YYYY-MM') as month,
      coalesce(sum(case when s.cycle = 'yearly' then i.amount_cents / 12 else i.amount_cents end), 0)::int as mrr,
      count(distinct i.subscription_id)::int as paying
    from invoices i join subscriptions s on s.id = i.subscription_id
    where i.status = 'paid' and i.due_date >= ${`${monthKeys[0]}-01`}
    group by 1`);
  const mrrTrend = monthKeys.map((month) => {
    const hit = invoiceRows.find((r) => r.month === month);
    return { month, mrrCents: hit?.mrr ?? 0, payingCompanies: hit?.paying ?? 0 };
  });
  const mrrIsSample = !invoiceRows.some((r) => r.mrr > 0);

  // cadastros por semana (segunda a domingo, fuso da plataforma)
  const currentWeek = mondayOf(today);
  const firstWeek = addDaysIso(currentWeek, -(WEEKS - 1) * 7);
  const signupRows = await db.execute<{ week: string; n: number }>(sql`
    select to_char(date_trunc('week', (created_at at time zone ${sql.raw(TZ)}))::date, 'YYYY-MM-DD') as week, count(*)::int as n
    from organization
    where (created_at at time zone ${sql.raw(TZ)})::date >= ${firstWeek}
    group by 1`);
  const signupsPerWeek = Array.from({ length: WEEKS }, (_, i) => {
    const weekStart = addDaysIso(firstWeek, i * 7);
    return { weekStart, count: signupRows.find((r) => r.week === weekStart)?.n ?? 0 };
  });

  const trialSoon = addDaysIso(today, 3);
  return {
    kpis: {
      activeCompanies: companies.filter(({ company }) => company.status === "active").length,
      trialCompanies: companies.filter(({ company }) => company.status === "trial").length,
      overdueCompanies: companies.filter(({ company }) => company.status === "overdue" || company.status === "past_due").length,
      estimatedMonthlyRevenueCents: estimated,
    },
    mrrTrend,
    mrrIsSample,
    signupsPerWeek,
    recentSignups: [...companies]
      .sort((a, b) => b.company.createdAt.localeCompare(a.company.createdAt))
      .slice(0, 5)
      .map(({ company }) => ({
        id: company.id,
        name: company.name,
        planName: company.planName,
        onTrial: company.onTrial,
        createdAt: company.createdAt,
      })),
    needsAttention: companies
      .filter(({ company }) => company.status === "overdue" || company.status === "past_due" || (company.status === "trial" && company.dueDate <= trialSoon))
      .sort((a, b) => (b.company.daysPastDue ?? -1) - (a.company.daysPastDue ?? -1))
      .map(({ company }) => ({
        id: company.id,
        name: company.name,
        status: company.status,
        daysPastDue: company.daysPastDue,
        dueDate: company.dueDate,
      })),
  };
}
