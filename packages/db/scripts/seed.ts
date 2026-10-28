import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/schema";

/**
 * Dados de desenvolvimento. Idempotente (upsert).
 * As contas usam os mesmos ids das contas de exemplo do front, para os módulos que
 * ainda estão com dados de exemplo (Conversas, Agenda…) continuarem batendo.
 * Senha de teste de todas: duckchat123
 */
if (process.env.NODE_ENV === "production") {
  // contas de teste com senha conhecida e planos de exemplo: nunca em produção
  throw new Error("O seed de desenvolvimento não roda com NODE_ENV=production.");
}
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("Defina DATABASE_ADMIN_URL em packages/db/.env");
const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema, casing: "snake_case" });

const TEST_PASSWORD = "duckchat123";
const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

// `monthly_token_limit` (null = ilimitado) é a fonte única do orçamento mensal de tokens de IA (antes ficava em código).
// Valores iniciais conservadores [A DEFINIR pelo negócio]; o upsert mantém os do banco se o admin já os ajustou.
await db
  .insert(schema.plans)
  .values([
    { slug: "basico", name: "Básico", maxChannels: 2, maxUsers: 2, maxAgents: 1, features: [], monthlyTokenLimit: 1_500_000 },
    { slug: "pro", name: "Pro", maxChannels: 5, maxUsers: 5, maxAgents: null, features: ["campaigns", "instagram"], monthlyTokenLimit: 8_000_000 },
    { slug: "empresarial", name: "Empresarial", maxChannels: 15, maxUsers: 20, maxAgents: null, features: ["campaigns", "instagram", "copilot", "byo_ai"], monthlyTokenLimit: 30_000_000 },
  ])
  .onConflictDoNothing();
// planos já existentes sem orçamento (criados antes da coluna) recebem o valor inicial; os demais ficam como estão
for (const [slug, limit] of [["basico", 1_500_000], ["pro", 8_000_000], ["empresarial", 30_000_000]] as const) {
  await db.update(schema.plans).set({ monthlyTokenLimit: limit }).where(sql`${schema.plans.slug} = ${slug} and ${schema.plans.monthlyTokenLimit} is null`);
}

const orgs = [
  { id: "org_alvorada", name: "Casa Alvorada Odontologia", slug: "casa-alvorada", plan: "pro", status: "active", end: days(17) },
  { id: "org_lume", name: "Studio Lume", slug: "studio-lume", plan: "basico", status: "expired", end: days(-3) },
] as const;

const people = [
  { id: "usr_marina", name: "Marina Alves", email: "marina@casaalvorada.com.br", org: "org_alvorada", role: "owner" },
  { id: "usr_rafael", name: "Rafael Costa", email: "rafael@casaalvorada.com.br", org: "org_alvorada", role: "member" },
  { id: "usr_lume", name: "Lia Moraes", email: "contato@studiolume.com.br", org: "org_lume", role: "owner" },
] as const;

const password = await hashPassword(TEST_PASSWORD);

await db.transaction(async (tx) => {
  for (const org of orgs) {
    await tx
      .insert(schema.organization)
      .values({ id: org.id, name: org.name, slug: org.slug, createdAt: now, timeZone: "America/Sao_Paulo" })
      .onConflictDoNothing();
    await tx
      .insert(schema.subscriptions)
      .values({ id: crypto.randomUUID(), organizationId: org.id, planSlug: org.plan, status: org.status, currentPeriodEnd: org.end })
      .onConflictDoUpdate({
        target: schema.subscriptions.organizationId,
        set: { planSlug: org.plan, status: org.status, currentPeriodEnd: org.end, updatedAt: sql`now()` },
      });
  }
  for (const p of people) {
    await tx
      .insert(schema.user)
      .values({ id: p.id, name: p.name, email: p.email, emailVerified: true, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await tx
      .insert(schema.account)
      .values({ id: `acc_${p.id}`, accountId: p.id, providerId: "credential", userId: p.id, password, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: schema.account.id, set: { password } });
    await tx
      .insert(schema.member)
      .values({ id: `mem_${p.id}`, organizationId: p.org, userId: p.id, role: p.role, createdAt: now })
      .onConflictDoNothing();
  }
});

await client.end();
console.log(`Seed ok: ${orgs.length} empresas, ${people.length} pessoas.`);
