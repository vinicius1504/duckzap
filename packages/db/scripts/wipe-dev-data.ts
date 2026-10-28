import postgres from "postgres";

/**
 * Apaga TODOS os dados de empresas do banco de DESENVOLVIMENTO (empresas, pessoas, contatos, conversas, canais,
 * campanhas, agentes…) para testar do zero, por exemplo conectando o seu próprio WhatsApp.
 *
 * Mantém: planos, super admins do painel (platform_admins e sessões) e o histórico de auditoria (append-only).
 * Depois de rodar, crie a sua empresa pelo cadastro real em http://localhost:3000/comecar (vira Proprietário,
 * com 14 dias de teste do plano Pro).
 *
 * Segurança: só roda com CONFIRM_WIPE=sim, nunca com NODE_ENV=production e só no banco chamado `duckzap`
 * ou com ALLOW_WIPE_DB=<nome> para outro banco de desenvolvimento.
 *
 *   CONFIRM_WIPE=sim pnpm --filter @duckzap/db db:wipe-dev
 */
if (process.env.NODE_ENV === "production") throw new Error("Recusado: NODE_ENV=production.");
if (process.env.CONFIRM_WIPE !== "sim") {
  throw new Error("Isto apaga todos os dados de empresas. Rode de novo com CONFIRM_WIPE=sim se é isso mesmo que você quer.");
}
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("Defina DATABASE_ADMIN_URL (dono do banco) em packages/db/.env");

const sql = postgres(url, { max: 1 });
const [current] = await sql<{ name: string }[]>`select current_database() as name`;
const name = current?.name ?? "";
if (name !== "duckzap" && process.env.ALLOW_WIPE_DB !== name) {
  await sql.end();
  throw new Error(`Recusado: o banco "${name}" não é o de desenvolvimento ("duckzap"). Use ALLOW_WIPE_DB=${name} se for de propósito.`);
}

const before = await sql<{ orgs: string; users: string }[]>`
  select (select count(*) from organization)::text as orgs, (select count(*) from "user")::text as users`;

await sql.begin(async (tx) => {
  // as tabelas de negócio saem em cascata (organization_id → organization ON DELETE CASCADE)
  await tx`delete from organization`;
  // pessoas, sessões, contas, vínculos e convites (cascata a partir de "user"); tokens soltos de verificação
  await tx`delete from "user"`;
  await tx`delete from verification`;
});

const after = await sql<{ orgs: string; users: string; plans: string; admins: string }[]>`
  select (select count(*) from organization)::text as orgs, (select count(*) from "user")::text as users,
         (select count(*) from plans)::text as plans, (select count(*) from platform_admins)::text as admins`;
await sql.end();

console.log(`Apagado: ${before[0]?.orgs} empresas e ${before[0]?.users} pessoas (e tudo que dependia delas).`);
console.log(`Mantido: ${after[0]?.plans} planos e ${after[0]?.admins} super admins.`);
console.log("Agora crie a sua empresa em http://localhost:3000/comecar e conecte o seu WhatsApp em Canais.");
