import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/schema";

/**
 * Dois super admins de DESENVOLVIMENTO. Idempotente (upsert por e-mail).
 * A senha vem de ADMIN_SEED_PASSWORD (nunca impressa). O 2FA NÃO é semeado: no primeiro login o painel
 * mostra a chave para cadastrar no app autenticador (fluxo de enrollment obrigatório).
 * Rode com o papel dono (DATABASE_ADMIN_URL), como o seed principal.
 */
const url = process.env.DATABASE_ADMIN_URL;
const password = process.env.ADMIN_SEED_PASSWORD;
if (!url) throw new Error("Defina DATABASE_ADMIN_URL em packages/db/.env");
if (!password || password.length < 12) throw new Error("Defina ADMIN_SEED_PASSWORD (mínimo 12 caracteres) em packages/db/.env");
if (process.env.NODE_ENV === "production") throw new Error("seed-admin é só para desenvolvimento.");

// Senha fraca/padrão só em banco local. Em qualquer outro host, recusa (o 1º admin de produção segue docs/runbooks/primeiro-admin.md).
const WEAK = [/^duckadmin/i, /^admin/i, /^password/i, /^senha/i, /^12345/, /^qwerty/i, /^(.)\1+$/];
const isLocalDatabase = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname);
if (!isLocalDatabase && (WEAK.some((rule) => rule.test(password)) || password.length < 16)) {
  throw new Error("ADMIN_SEED_PASSWORD fraca ou padrão para um banco que não é local: use uma senha forte de 16+ caracteres.");
}

const client = postgres(url, { max: 1 });
const db = drizzle(client, { schema, casing: "snake_case" });

const admins = [
  { name: "Equipe DuckChat", email: "admin@duckchat.com.br" },
  { name: "Bruno Carvalho", email: "bruno@duckchat.com.br" },
] as const;

const passwordHash = await hashPassword(password);
const now = new Date();

for (const admin of admins) {
  const [existing] = await db
    .select({ id: schema.platformAdmins.id })
    .from(schema.platformAdmins)
    .where(sql`lower(${schema.platformAdmins.email}) = ${admin.email}`);
  if (existing) {
    await db
      .update(schema.platformAdmins)
      .set({ name: admin.name, passwordHash, active: true, failedAttempts: 0, lockedUntil: null, updatedAt: now })
      .where(sql`${schema.platformAdmins.id} = ${existing.id}`);
  } else {
    await db.insert(schema.platformAdmins).values({
      id: crypto.randomUUID(),
      email: admin.email,
      name: admin.name,
      passwordHash,
    });
  }
}

await client.end();
console.log(`Seed admin ok: ${admins.length} super admins (senha de ADMIN_SEED_PASSWORD; 2FA configurado no primeiro login).`);
console.log(
  "Em produção o 1º acesso exige o código de ativação: pnpm --filter @duckzap/api exec tsx --env-file-if-exists=.env scripts/admin-activation-code.ts <email> (docs/runbooks/primeiro-admin.md).",
);
