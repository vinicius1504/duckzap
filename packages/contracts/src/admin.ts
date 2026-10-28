import { z } from "zod";

// Painel Super Admin (§1.1 "Painel Admin", §5.1). Rotas /v1/admin/* na API, papel de banco
// separado; toda mutação exige motivo e gera uma linha em audit_logs.

const id = z.string().min(1);
const isoDate = z.iso.date();
const cents = z.number().int().min(0);

/* ───────────── Auth do super admin ───────────── */

export const adminSignInSchema = z.object({
  email: z.email({ error: "Informe um e-mail válido." }).trim().toLowerCase(),
  password: z.string().min(1, { error: "Informe sua senha." }).max(128),
  /** Só no 1º acesso (cadastro do 2FA): código de ativação gerado no servidor (`scripts/admin-activation-code.ts`). */
  activationCode: z.string().trim().max(64).optional(),
});
export type AdminSignInInput = z.infer<typeof adminSignInSchema>;

export const adminTwoFactorSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, { error: "O código tem 6 números." }),
});
export type AdminTwoFactorInput = z.infer<typeof adminTwoFactorSchema>;

export const adminUserSchema = z.object({
  id,
  name: z.string(),
  email: z.email(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminSessionSchema = z.object({
  admin: adminUserSchema,
  expiresAt: z.iso.datetime(),
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

/* ───────────── Planos ───────────── */

export const planFeaturesSchema = z.object({
  campaigns: z.boolean(),
  instagram: z.boolean(),
  copilot: z.boolean(),
});
export type PlanFeatures = z.infer<typeof planFeaturesSchema>;
export type PlanFeature = keyof PlanFeatures;

export const planLimitsSchema = z.object({
  channels: z.number().int().min(1).max(999),
  users: z.number().int().min(1).max(999),
  /** null = ilimitados */
  agents: z.number().int().min(1).max(999).nullable(),
});
export type PlanLimits = z.infer<typeof planLimitsSchema>;

export const planSchema = z.object({
  id,
  name: z.string(),
  /** Centavos. null = preço ainda não definido (exibe "R$ [VALOR]"). */
  firstMonthPriceCents: cents.nullable(),
  recurringPriceCents: cents.nullable(),
  limits: planLimitsSchema,
  features: planFeaturesSchema,
  /** Link de checkout do gateway. null = ainda não definido (exibe "[LINK]"). */
  checkoutUrl: z.url().nullable(),
  active: z.boolean(),
  /** Quantas empresas estão no plano hoje (derivado). */
  companiesCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});
export type Plan = z.infer<typeof planSchema>;

const reason = z
  .string()
  .trim()
  .min(10, { error: "Explique o motivo (pelo menos 10 caracteres)." })
  .max(500, { error: "Use no máximo 500 caracteres." });

export const planInputSchema = z.object({
  name: z.string().trim().min(2, { error: "Informe o nome do plano." }).max(60),
  firstMonthPriceCents: cents.max(100_000_00).nullable(),
  recurringPriceCents: cents.max(100_000_00).nullable(),
  limits: planLimitsSchema,
  features: planFeaturesSchema,
  checkoutUrl: z.url({ protocol: /^https$/, error: "Use um link https:// válido." }).nullable(),
  active: z.boolean(),
  reason,
});
export type PlanInput = z.infer<typeof planInputSchema>;

/* ───────────── Empresas ───────────── */

/**
 * Situação da empresa (calculada no back a partir da assinatura):
 * active = em dia · trial = em teste · overdue = vencida (até 10 dias) ·
 * past_due = atrasada (11 a 30 dias) · expired = expirada (teste acabou ou +30 dias) · disabled = desativada.
 */
export const companyStatusSchema = z.enum([
  "active",
  "trial",
  "overdue",
  "past_due",
  "expired",
  "disabled",
]);
export type CompanyStatus = z.infer<typeof companyStatusSchema>;

export const companyFilterSchema = z.enum([
  "all",
  "active",
  "trial",
  "overdue",
  "past_due",
  "expired",
]);
export type CompanyFilter = z.infer<typeof companyFilterSchema>;

export const companySchema = z.object({
  id,
  name: z.string(),
  ownerName: z.string(),
  email: z.email(),
  phone: z.string(),
  /** CNPJ (só dígitos) */
  document: z.string(),
  city: z.string(),
  segment: z.string(),
  planId: id,
  planName: z.string(),
  onTrial: z.boolean(),
  /** Próximo vencimento (ou fim do teste). */
  dueDate: isoDate,
  status: companyStatusSchema,
  /** Dias desde o vencimento; null se ainda não venceu. */
  daysPastDue: z.number().int().min(0).nullable(),
  enabled: z.boolean(),
  usage: z.object({
    channels: z.number().int(),
    users: z.number().int(),
    agents: z.number().int(),
  }),
  createdAt: z.iso.datetime(),
});
export type Company = z.infer<typeof companySchema>;

export const companyListQuerySchema = z.object({
  filter: companyFilterSchema,
  search: z.string().max(100),
  page: z.number().int().min(1),
});
export type CompanyListQuery = z.infer<typeof companyListQuerySchema>;

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export type CompanyCounts = Record<CompanyFilter, number>;

export const changeCompanyPlanSchema = z.object({
  companyId: id,
  planId: id,
  reason,
});
export type ChangeCompanyPlanInput = z.infer<typeof changeCompanyPlanSchema>;

export const extendCompanySchema = z.object({
  companyId: id,
  /** Novo vencimento (data local da plataforma). */
  dueDate: isoDate,
  reason,
});
export type ExtendCompanyInput = z.infer<typeof extendCompanySchema>;

export const setCompanyEnabledSchema = z.object({
  companyId: id,
  enabled: z.boolean(),
  reason,
});
export type SetCompanyEnabledInput = z.infer<typeof setCompanyEnabledSchema>;

/* ───────────── Assinaturas e faturas ───────────── */

export const billingCycleSchema = z.enum(["monthly", "yearly"]);
export type BillingCycle = z.infer<typeof billingCycleSchema>;

export const subscriptionStatusAdminSchema = z.enum([
  "trial",
  "active",
  "overdue",
  "past_due",
  "expired",
  "canceled",
]);
export type SubscriptionAdminStatus = z.infer<typeof subscriptionStatusAdminSchema>;

export const subscriptionFilterSchema = z.enum([
  "all",
  "active",
  "trial",
  "late",
  "expired",
  "canceled",
]);
export type SubscriptionFilter = z.infer<typeof subscriptionFilterSchema>;

export const subscriptionSchema = z.object({
  id,
  companyId: id,
  companyName: z.string(),
  planId: id,
  planName: z.string(),
  onTrial: z.boolean(),
  /** Valor recorrente em centavos; null = preço do plano a definir. */
  amountCents: cents.nullable(),
  cycle: billingCycleSchema,
  nextDueDate: isoDate,
  status: subscriptionStatusAdminSchema,
  daysPastDue: z.number().int().min(0).nullable(),
  /** Gateway de pagamento (Asaas ou Stripe, §2: a decidir em ADR). null = não definido. */
  gateway: z.string().nullable(),
  gatewayReference: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const subscriptionListQuerySchema = z.object({
  filter: subscriptionFilterSchema,
  search: z.string().max(100),
  page: z.number().int().min(1),
});
export type SubscriptionListQuery = z.infer<typeof subscriptionListQuerySchema>;

export type SubscriptionCounts = Record<SubscriptionFilter, number>;

export const invoiceStatusSchema = z.enum(["paid", "open", "overdue", "void"]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const paymentMethodSchema = z.enum(["pix", "boleto", "card"]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const invoiceSchema = z.object({
  id,
  subscriptionId: id,
  number: z.string(),
  dueDate: isoDate,
  amountCents: cents.nullable(),
  status: invoiceStatusSchema,
  paidAt: z.iso.datetime().nullable(),
  method: paymentMethodSchema.nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

/* ───────────── Auditoria ───────────── */

export const auditActionSchema = z.enum([
  "company.plan_changed",
  "company.due_date_extended",
  "company.disabled",
  "company.enabled",
  "plan.created",
  "plan.updated",
  "plan.deleted",
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditFilterSchema = z.enum(["all", "companies", "plans"]);
export type AuditFilter = z.infer<typeof auditFilterSchema>;

export const auditEntrySchema = z.object({
  id,
  at: z.iso.datetime(),
  actor: adminUserSchema,
  action: auditActionSchema,
  target: z.object({ type: z.enum(["company", "plan"]), id, name: z.string() }),
  /** Empresa afetada (null em ações só de plano). */
  company: z.object({ id, name: z.string() }).nullable(),
  /** Mudanças campo a campo, já como texto de exibição (ex.: "Plano", "Pro", "Escala"). */
  changes: z.array(
    z.object({ field: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
  ),
  reason: z.string(),
  /** IP de origem (a API grava; o mock usa um fixo). */
  ip: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListQuerySchema = z.object({
  filter: auditFilterSchema,
  search: z.string().max(100),
  companyId: id.optional(),
  page: z.number().int().min(1),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

/* ───────────── Visão geral ───────────── */

export const platformOverviewSchema = z.object({
  kpis: z.object({
    activeCompanies: z.number().int(),
    trialCompanies: z.number().int(),
    overdueCompanies: z.number().int(),
    /** null enquanto algum plano ativo não tiver preço (exibe "R$ [VALOR]"). */
    estimatedMonthlyRevenueCents: cents.nullable(),
  }),
  /** MRR mês a mês (centavos). `isSample` = valores de exemplo enquanto os preços estão a definir. */
  mrrTrend: z.array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      mrrCents: cents,
      payingCompanies: z.number().int(),
    }),
  ),
  mrrIsSample: z.boolean(),
  signupsPerWeek: z.array(z.object({ weekStart: isoDate, count: z.number().int() })),
  recentSignups: z.array(
    z.object({
      id,
      name: z.string(),
      planName: z.string(),
      onTrial: z.boolean(),
      createdAt: z.iso.datetime(),
    }),
  ),
  needsAttention: z.array(
    z.object({
      id,
      name: z.string(),
      status: companyStatusSchema,
      daysPastDue: z.number().int().nullable(),
      dueDate: isoDate,
    }),
  ),
});
export type PlatformOverview = z.infer<typeof platformOverviewSchema>;

/** Resposta das mutações do painel (Server Actions). */
export type AdminActionResult = { ok: true; message: string } | { ok: false; error: string };
