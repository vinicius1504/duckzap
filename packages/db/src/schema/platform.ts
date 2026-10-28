import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** Planos da plataforma (§1.2). Limites e recursos vivem aqui, não em código. */
export const plans = pgTable("plans", {
  slug: text().primaryKey(),
  name: text().notNull(),
  maxChannels: integer().notNull(),
  maxUsers: integer().notNull(),
  /** null = ilimitado */
  maxAgents: integer(),
  /** Orçamento mensal de tokens de IA da empresa. null = ilimitado. Fonte única (antes ficava em env/código). */
  monthlyTokenLimit: integer(),
  features: text().array().notNull().default(sql`'{}'::text[]`),
  firstMonthPriceCents: integer(),
  recurringPriceCents: integer(),
  /** Link de checkout do gateway (https). null = ainda não definido. Editado só pelo Painel Admin. */
  checkoutUrl: text(),
  active: boolean().notNull().default(true),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Primeira tabela de negócio com RLS: cada empresa só enxerga a própria assinatura. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid().primaryKey(),
    organizationId: text()
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    planSlug: text()
      .notNull()
      .references(() => plans.slug),
    status: text().notNull(),
    currentPeriodEnd: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Painel Admin: em teste. Guardado à parte porque `status` vira 'canceled' quando a empresa é desativada. */
    onTrial: boolean().notNull().default(false),
    /** Painel Admin: ciclo de cobrança. */
    cycle: text().notNull().default("monthly"),
    /** Painel Admin: empresa desativada manualmente (null = ativa). */
    disabledAt: timestamp({ withTimezone: true }),
    /** Gateway de pagamento [A DEFINIR] (Asaas ou Stripe, ADR pendente). */
    gateway: text(),
    gatewayReference: text(),
  },
  (t) => [
    index("subscriptions_plan_slug_idx").on(t.planSlug),
    check("subscriptions_cycle_check", sql`${t.cycle} in ('monthly','yearly')`),
    check("subscriptions_status_check", sql`${t.status} in ('trial','active','past_due','expired','canceled')`),
    pgPolicy("subscriptions_tenant_isolation", {
      as: "permissive",
      for: "all",
      using: sql`${t.organizationId} = current_setting('app.org_id', true)`,
      withCheck: sql`${t.organizationId} = current_setting('app.org_id', true)`,
    }),
  ],
).enableRLS();

// Painel Super Admin: identidade, sessões, auditoria e faturas da plataforma (tabelas NÃO tenant, sem RLS).
export * from "./admin";
