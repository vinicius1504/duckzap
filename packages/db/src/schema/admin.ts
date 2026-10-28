import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { subscriptions } from "./platform";

/**
 * Painel Super Admin (§1.1, §5.1). Tabelas da PLATAFORMA: não têm organization_id nem RLS.
 * Quem protege é o papel de banco: `duckzap_app` NÃO tem nenhum privilégio aqui (revoke em
 * scripts/setup-roles.ts, coberto por test/admin-roles.test.ts); só `duckzap_admin` lê/escreve.
 * Ids: UUID v7 gerados pela API.
 */

/** Equipe da plataforma. Identidade SEPARADA dos clientes (`user` do Better Auth). */
export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid().primaryKey(),
    email: text().notNull(),
    name: text().notNull(),
    /** hash scrypt do Better Auth (`hashPassword`) */
    passwordHash: text().notNull(),
    /** segredo TOTP cifrado em repouso (AES-GCM, lib/crypto.ts). null = 2FA ainda não configurado (1º login). */
    totpSecretEnc: text(),
    totpEnabledAt: timestamp({ withTimezone: true }),
    /** último passo (30 s) TOTP aceito: impede reuso do mesmo código */
    totpLastStep: integer(),
    failedAttempts: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    active: boolean().notNull().default(true),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("platform_admins_email_key").on(sql`lower(${t.email})`)],
);

/** Sessões do painel no banco (cookie `dz_admin`). Só o hash SHA-256 do token é guardado. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid().primaryKey(),
    adminId: uuid()
      .notNull()
      .references(() => platformAdmins.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    ip: text(),
    userAgent: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("admin_sessions_admin_id_idx").on(t.adminId)],
);

/** Desafio entre a senha e o código 2FA (5 min, uso único, máx. 5 códigos errados). */
export const adminChallenges = pgTable(
  "admin_challenges",
  {
    id: uuid().primaryKey(),
    adminId: uuid()
      .notNull()
      .references(() => platformAdmins.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    /** 1º login: segredo TOTP gerado, cifrado, ainda não confirmado. null = admin já tem 2FA. */
    pendingTotpSecretEnc: text(),
    attempts: integer().notNull().default(0),
    ip: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("admin_challenges_admin_id_idx").on(t.adminId)],
);

export type AuditChange = { field: string; from: string | null; to: string | null };

/**
 * Auditoria (§5.1): quem, o quê, qual empresa, motivo, antes→depois, IP e quando.
 * APENAS INSERÇÃO: o papel admin não tem UPDATE/DELETE/TRUNCATE e há trigger que recusa ambos
 * para qualquer papel (ver schema/admin.sql.md e setup-roles.ts).
 * `kind = 'mutation'` exige motivo ≥ 10 caracteres (check no banco); `'auth'` registra login/saída.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid().primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    kind: text().notNull(),
    /** null quando o e-mail tentado não existe (login falho) */
    actorId: uuid(),
    actorName: text().notNull(),
    actorEmail: text().notNull(),
    action: text().notNull(),
    targetType: text().notNull(),
    targetId: text().notNull(),
    targetName: text().notNull(),
    companyId: text(),
    companyName: text(),
    reason: text().notNull(),
    before: jsonb(),
    after: jsonb(),
    /** diferenças já em texto de exibição: [{field, from, to}] */
    changes: jsonb().$type<AuditChange[]>().notNull().default(sql`'[]'::jsonb`),
    ip: text(),
  },
  (t) => [
    index("audit_logs_at_idx").on(t.at.desc()),
    index("audit_logs_company_idx").on(t.companyId),
    check("audit_logs_kind_check", sql`${t.kind} in ('mutation','auth')`),
    check("audit_logs_reason_check", sql`${t.kind} = 'auth' or char_length(btrim(${t.reason})) >= 10`),
  ],
);

/** Faturas da plataforma. A integração com o gateway é `[A DEFINIR]`; hoje só leitura no painel. */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid().primaryKey(),
    subscriptionId: uuid()
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    number: text().notNull().unique(),
    /** centavos; null = preço do plano ainda a definir */
    amountCents: integer(),
    dueDate: date({ mode: "string" }).notNull(),
    status: text().notNull(),
    paidAt: timestamp({ withTimezone: true }),
    method: text(),
    gatewayReference: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("invoices_subscription_idx").on(t.subscriptionId, t.dueDate.desc()),
    check("invoices_status_check", sql`${t.status} in ('paid','open','overdue','void')`),
    check("invoices_method_check", sql`${t.method} is null or ${t.method} in ('pix','boleto','card')`),
    check("invoices_amount_check", sql`${t.amountCents} is null or ${t.amountCents} >= 0`),
  ],
);
