import { hashPassword } from "better-auth/crypto";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

/**
 * Cria uma pessoa (login) numa empresa que já existe, SÓ para desenvolvimento: útil para testar o atendimento com
 * uma segunda pessoa sem passar pelo convite por e-mail. A senha é gerada na hora e impressa uma única vez.
 *
 *   OWNER_EMAIL=dono@empresa.com MEMBER_EMAIL=atendente@duckchat.test MEMBER_NAME="Atendente Teste" \
 *     pnpm --filter @duckzap/db db:add-member
 *
 * MEMBER_ROLE: agent (Atendente, padrão) | admin | owner (os papéis do contrato de Equipe). Só roda fora de
 * produção e só no banco `duckzap` (ou ALLOW_DB=<nome>). Não mexe em nada além de user, account e member.
 */
if (process.env.NODE_ENV === "production") throw new Error("Recusado: NODE_ENV=production.");
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("Defina DATABASE_ADMIN_URL (dono do banco) em packages/db/.env");

const ownerEmail = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
const email = (process.env.MEMBER_EMAIL ?? "").trim().toLowerCase();
const name = (process.env.MEMBER_NAME ?? "").trim();
const role = (process.env.MEMBER_ROLE ?? "agent").trim();
if (!ownerEmail || !email || !name) throw new Error("Defina OWNER_EMAIL, MEMBER_EMAIL e MEMBER_NAME.");
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("MEMBER_EMAIL inválido.");

const sql = postgres(url, { max: 1 });
try {
  const [current] = await sql<{ name: string }[]>`select current_database() as name`;
  const dbName = current?.name ?? "";
  if (dbName !== "duckzap" && process.env.ALLOW_DB !== dbName) {
    throw new Error(`Recusado: o banco "${dbName}" não é o de desenvolvimento ("duckzap"). Use ALLOW_DB=${dbName} se for de propósito.`);
  }

  const owners = await sql<{ org: string; orgName: string }[]>`
    select m.organization_id as org, o.name as "orgName"
    from member m join "user" u on u.id = m.user_id join organization o on o.id = m.organization_id
    where lower(u.email) = ${ownerEmail} and m.role = 'owner'`;
  if (owners.length !== 1) throw new Error(`Esperava exatamente uma empresa cujo Proprietário é ${ownerEmail}; achei ${owners.length}.`);
  const { org, orgName } = owners[0]!;

  const [exists] = await sql`select 1 from "user" where lower(email) = ${email}`;
  if (exists) throw new Error(`Já existe uma pessoa com o e-mail ${email}.`);

  // 16 caracteres sem símbolos ambíguos; mostrada uma vez, nunca gravada em texto
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  const hash = await hashPassword(password);

  const id = randomUUID();
  const now = new Date();
  await sql.begin(async (tx) => {
    await tx`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${id}, ${name}, ${email}, true, ${now}, ${now})`;
    await tx`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (${randomUUID()}, ${id}, 'credential', ${id}, ${hash}, ${now}, ${now})`;
    await tx`insert into member (id, organization_id, user_id, role, created_at) values (${randomUUID()}, ${org}, ${id}, ${role}, ${now})`;
  });

  console.log(`Criado em "${orgName}": ${name} (${role})`);
  console.log(`E-mail: ${email}`);
  console.log(`Senha:  ${password}`);
  console.log("Entre em http://localhost:3000/entrar. Troque a senha em Minha conta depois dos testes.");
} finally {
  await sql.end();
}
