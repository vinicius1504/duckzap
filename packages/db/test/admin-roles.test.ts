import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../src";

// Painel Admin (§3.4/§5.1) — INTEGRAÇÃO: precisa da migration das tabelas de admin.ts + `db:roles` aplicados.
// Verifica a fronteira de privilégios: o app não toca nas tabelas de admin; o papel admin ignora RLS mas é mínimo
// e a auditoria é append-only.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}
const appUrl = process.env.DATABASE_URL;
const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!appUrl || !adminUrl) throw new Error("Defina DATABASE_URL (duckzap_app) e ADMIN_DATABASE_URL (duckzap_admin) em packages/db/.env");

const app = createDb(appUrl, { max: 1 });
const admin = createDb(adminUrl, { max: 1 });
afterAll(async () => {
  await app.close();
  await admin.close();
});

const adminTables = ["platform_admins", "admin_sessions", "admin_challenges", "audit_logs", "invoices"];

async function denied(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: { code?: string }; code?: string }).cause ?? (error as { code?: string });
    return cause.code;
  }
  return null;
}

/** Executa e desfaz no fim: o teste não suja o banco. */
async function rollback(fn: (tx: Parameters<Parameters<typeof admin.db.transaction>[0]>[0]) => Promise<void>) {
  const marker = new Error("rollback");
  try {
    await admin.db.transaction(async (tx) => {
      await fn(tx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

const auditRow = (reason: string, kind = "mutation") => sql`
  insert into audit_logs (id, kind, actor_name, actor_email, action, target_type, target_id, target_name, reason)
  values (${crypto.randomUUID()}, ${kind}, 'Teste', 'teste@duckchat.com.br', 'plan.updated', 'plan', 'x', 'X', ${reason})`;

describe("papel do app (duckzap_app) não enxerga tabelas de admin", () => {
  for (const table of adminTables) {
    it(`select em ${table} é negado (42501)`, async () => {
      expect(await denied(() => app.db.execute(sql.raw(`select 1 from ${table} limit 1`)))).toBe("42501");
    });
  }
  it("insert em audit_logs é negado", async () => {
    expect(await denied(() => app.db.execute(auditRow("motivo válido de teste")))).toBe("42501");
  });
});

describe("papel do painel (duckzap_admin)", () => {
  it("ignora RLS mas não é superuser", async () => {
    const [role] = await admin.db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolbypassrls: true, rolsuper: false });
  });

  it("lê assinaturas de todas as empresas (BYPASSRLS)", async () => {
    const rows = await admin.db.execute(sql`select organization_id from subscriptions`);
    expect(rows.length).toBeGreaterThan(1);
  });

  it("não lê a tabela de usuários além de id, name e email", async () => {
    expect(await denied(() => admin.db.execute(sql`select email from "user" limit 1`))).toBeNull();
    expect(await denied(() => admin.db.execute(sql`select * from "user" limit 1`))).toBe("42501");
    expect(await denied(() => admin.db.execute(sql`select password from account limit 1`))).toBe("42501");
  });

  it("não tem acesso a tabelas de conteúdo (mensagens, contatos, conversas)", async () => {
    const content = await admin.db.execute<{ t: string }>(sql`
      select tablename as t from pg_tables
      where schemaname = 'public' and tablename in ('messages','message','contacts','contact','conversations','conversation','appointments')`);
    for (const { t } of content) {
      expect(await denied(() => admin.db.execute(sql.raw(`select 1 from "${t}" limit 1`)))).toBe("42501");
    }
  });
});

describe("audit_logs é append-only", () => {
  it("aceita inserção com motivo ≥ 10 caracteres", async () => {
    await rollback(async (tx) => {
      await tx.execute(auditRow("motivo válido de teste"));
    });
  });

  it("recusa mutação sem motivo suficiente (check no banco)", async () => {
    expect(await denied(() => admin.db.execute(auditRow("curto")))).toBe("23514");
  });

  it("aceita evento de auth sem motivo longo", async () => {
    await rollback(async (tx) => {
      await tx.execute(auditRow("login", "auth"));
    });
  });

  it("papel admin não consegue UPDATE, DELETE nem TRUNCATE", async () => {
    expect(await denied(() => admin.db.execute(sql`update audit_logs set reason = 'adulterado!!!!'`))).toBe("42501");
    expect(await denied(() => admin.db.execute(sql`delete from audit_logs`))).toBe("42501");
    expect(await denied(() => admin.db.execute(sql`truncate audit_logs`))).toBe("42501");
  });

  it("o trigger também barra o dono do banco", async () => {
    const ownerUrl = process.env.DATABASE_ADMIN_URL;
    if (!ownerUrl) return;
    const owner = createDb(ownerUrl, { max: 1 });
    try {
      await owner.db.transaction(async (tx) => {
        await tx.execute(auditRow("motivo válido de teste"));
        const code = await denied(() => tx.execute(sql`update audit_logs set reason = 'adulterado!!!!'`));
        expect(code).toBe("42501");
        throw new Error("rollback");
      }).catch((e: Error) => {
        if (e.message !== "rollback" && !/aborted|rollback/i.test(String(e.message))) throw e;
      });
    } finally {
      await owner.close();
    }
  });
});
