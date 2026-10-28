import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, withOrg } from "../src";
import { subscriptions } from "../src/schema";

// §3.4: para cada tabela de negócio, a empresa A não lê nem escreve dados da empresa B.
// Roda contra o Postgres real com o papel do app (sem BYPASSRLS), usando o seed de dev.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Defina DATABASE_URL (papel duckzap_app) em packages/db/.env");

const { db, close } = createDb(url, { max: 2 });
afterAll(close);

const A = "org_alvorada";
const B = "org_lume";

/** Escritas dentro de uma transação desfeita no fim: o teste não suja o banco. */
async function rollback<T>(organizationId: string, fn: Parameters<typeof withOrg<T>>[2]) {
  const marker = new Error("rollback");
  try {
    await withOrg(db, organizationId, async (tx) => {
      await fn(tx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

describe("isolamento de tenant (RLS)", () => {
  it("o papel do app não ignora RLS", async () => {
    const [role] = await db.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
      sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  describe("subscriptions", () => {
    it("sem tenant definido, não enxerga nada", async () => {
      const rows = await db.select().from(subscriptions);
      expect(rows).toHaveLength(0);
    });

    it("A lê só a própria assinatura", async () => {
      const rows = await withOrg(db, A, (tx) => tx.select().from(subscriptions));
      expect(rows.map((r) => r.organizationId)).toEqual([A]);
    });

    it("A não altera a assinatura de B", async () => {
      await rollback(A, async (tx) => {
        const updated = await tx
          .update(subscriptions)
          .set({ status: "canceled" })
          .where(eq(subscriptions.organizationId, B))
          .returning();
        expect(updated).toHaveLength(0);
      });
    });

    it("A não apaga a assinatura de B", async () => {
      await rollback(A, async (tx) => {
        const deleted = await tx.delete(subscriptions).where(eq(subscriptions.organizationId, B)).returning();
        expect(deleted).toHaveLength(0);
      });
    });

    it("A não cria registro em nome de B", async () => {
      const error = await rollback(A, async (tx) => {
        await tx.insert(subscriptions).values({
          id: crypto.randomUUID(),
          organizationId: B,
          planSlug: "pro",
          status: "active",
          currentPeriodEnd: new Date(),
        });
      }).catch((e: unknown) => e);
      // o Drizzle embrulha o erro do Postgres; a causa precisa ser a policy, não outra restrição
      const cause = error instanceof Error ? error.cause : undefined;
      expect(cause instanceof Error ? cause.message : String(cause)).toMatch(/row-level security/);
    });
  });
});
