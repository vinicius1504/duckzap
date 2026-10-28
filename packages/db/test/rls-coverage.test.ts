import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../src";

// Rede de segurança (§3.4): toda tabela com organization_id TEM que ter RLS ligado e uma policy.
// Se um módulo novo esquecer, este teste falha antes de o dado de uma empresa poder vazar para outra.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL (papel duckzap_app) em packages/db/.env");

const { db, close } = createDb(url, { max: 1 });
afterAll(close);

/**
 * Exceções conscientes. `organization`, `member` e `invitation` pertencem ao Better Auth, que as consulta
 * fora de `withOrg` (ex.: listar as empresas da pessoa no login), então RLS por app.org_id as quebraria.
 * REGRA: todo acesso do produto a `member`/`invitation` filtra por organization_id explicitamente
 * (módulo Equipe) e é coberto por teste de autorização. Não acrescente tabelas de negócio aqui.
 */
const exempt = new Set<string>(["organization", "member", "invitation"]);

describe("cobertura de RLS", () => {
  it("toda tabela com organization_id tem RLS ligado e forçado ao papel do app", async () => {
    const rows = await db.execute<{ table: string; rls: boolean; policies: number }>(sql`
      select c.relname as table, c.relrowsecurity as rls,
             (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
      where c.relkind = 'r'
      order by c.relname
    `);
    const tenantTables = rows.filter((r) => !exempt.has(r.table));
    expect(tenantTables.length).toBeGreaterThan(0);
    const broken = tenantTables.filter((r) => !r.rls || r.policies === 0).map((r) => r.table);
    expect(broken, `tabelas sem RLS/policy: ${broken.join(", ")}`).toEqual([]);
  });

  it("o papel do app não é dono das tabelas (dono ignora RLS por padrão)", async () => {
    const rows = await db.execute<{ table: string }>(sql`
      select tablename as table from pg_tables
      where schemaname = 'public' and tableowner = current_user
    `);
    expect(rows.map((r) => r.table)).toEqual([]);
  });
});
