import { sql, type SQL } from "drizzle-orm";
import { pgPolicy, text, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** Coluna padrão de toda tabela de negócio (§3.4). */
export const organizationId = () =>
  text()
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });

/**
 * Policy padrão de isolamento: a linha só é visível/gravável quando `organization_id`
 * bate com `app.org_id` (definido por `withOrg`). Use junto com `.enableRLS()`:
 *
 *   pgTable("x", { organizationId: organizationId(), ... }, (t) => [tenantPolicy("x", t.organizationId)]).enableRLS()
 */
export function tenantPolicy(table: string, column: AnyPgColumn) {
  const expr: SQL = sql`${column} = current_setting('app.org_id', true)`;
  return pgPolicy(`${table}_tenant_isolation`, { as: "permissive", for: "all", using: expr, withCheck: expr });
}
