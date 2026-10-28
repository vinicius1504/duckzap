import postgres from "postgres";

/**
 * Cria/atualiza os papéis de banco (§3.4). Idempotente: pode rodar a cada deploy.
 *  - duckzap_app: LOGIN, sem SUPERUSER e sem BYPASSRLS (a API dos clientes).
 *  - duckzap_admin: LOGIN, sem SUPERUSER, COM BYPASSRLS (Painel Admin, §3.4/§5.1), mas com privilégios mínimos:
 *    só o que o painel precisa, nada de mensagens/contatos/conversas; audit_logs só INSERT/SELECT.
 *    Senha em ADMIN_DB_PASSWORD (se ausente, o papel admin é pulado com aviso).
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!adminUrl || !appPassword) throw new Error("Defina DATABASE_ADMIN_URL e APP_DB_PASSWORD em packages/db/.env");

const sql = postgres(adminUrl, { max: 1 });
const appRole = "duckzap_app";

const [exists] = await sql`select 1 from pg_roles where rolname = ${appRole}`;
if (!exists) await sql.unsafe(`create role ${appRole} login nosuperuser nobypassrls nocreatedb nocreaterole`);
await sql.unsafe(`alter role ${appRole} with login nosuperuser nobypassrls password '${appPassword.replace(/'/g, "''")}'`);

const [current] = await sql<{ db: string }[]>`select current_database() as db`;
const db = current?.db ?? "duckzap";
await sql.unsafe(`grant connect on database "${db}" to ${appRole}`);
await sql.unsafe(`grant usage on schema public to ${appRole}`);
await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${appRole}`);
await sql.unsafe(`grant usage, select on all sequences in schema public to ${appRole}`);
// tabelas criadas por migrations futuras (como dono) já nascem liberadas para o app
await sql.unsafe(`alter default privileges in schema public grant select, insert, update, delete on tables to ${appRole}`);
await sql.unsafe(`alter default privileges in schema public grant usage, select on sequences to ${appRole}`);
// a tabela de controle de migrations não é do app
await sql.unsafe(`revoke all on all tables in schema drizzle from ${appRole}`).catch(() => {});

// ───────── tabelas do Painel Admin: o app dos clientes não toca nelas (depois dos grants gerais acima) ─────────
const adminOnlyTables = ["platform_admins", "admin_sessions", "admin_challenges", "audit_logs", "invoices"];

async function tableExists(name: string) {
  const [row] = await sql`select to_regclass(${`public.${name}`}) is not null as ok`;
  return Boolean(row?.ok);
}
async function columnExists(table: string, column: string) {
  const [row] = await sql`select 1 as ok from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column}`;
  return Boolean(row);
}

for (const table of adminOnlyTables) {
  if (await tableExists(table)) await sql.unsafe(`revoke all on table ${table} from ${appRole}`);
}

// audit_logs: append-only para qualquer papel (trigger) — complementa o revoke de UPDATE/DELETE do papel admin
if (await tableExists("audit_logs")) {
  await sql.unsafe(`
    create or replace function audit_logs_immutable() returns trigger language plpgsql as $$
    begin
      raise exception 'audit_logs é append-only' using errcode = '42501';
    end $$;
    drop trigger if exists audit_logs_no_update_delete on audit_logs;
    create trigger audit_logs_no_update_delete before update or delete on audit_logs
      for each row execute function audit_logs_immutable();
    drop trigger if exists audit_logs_no_truncate on audit_logs;
    create trigger audit_logs_no_truncate before truncate on audit_logs
      for each statement execute function audit_logs_immutable();
  `);
}

// ───────── papel do Painel Admin ─────────
const adminRole = "duckzap_admin";
const adminPassword = process.env.ADMIN_DB_PASSWORD;
if (!adminPassword) {
  console.warn("ADMIN_DB_PASSWORD ausente: papel duckzap_admin NÃO foi criado/atualizado.");
} else {
  const [adminExists] = await sql`select 1 from pg_roles where rolname = ${adminRole}`;
  if (!adminExists) await sql.unsafe(`create role ${adminRole} login nosuperuser bypassrls nocreatedb nocreaterole`);
  await sql.unsafe(
    `alter role ${adminRole} with login nosuperuser bypassrls nocreatedb nocreaterole password '${adminPassword.replace(/'/g, "''")}'`,
  );
  await sql.unsafe(`grant connect on database "${db}" to ${adminRole}`);
  await sql.unsafe(`grant usage on schema public to ${adminRole}`);
  // reset: o papel admin parte do zero a cada execução (remove grants antigos que não estejam na lista)
  await sql.unsafe(`revoke all on all tables in schema public from ${adminRole}`);
  await sql.unsafe(`revoke all on all sequences in schema public from ${adminRole}`);

  const grants: [table: string, privileges: string][] = [
    ["organization", "select"],
    ["member", "select"],
    ["user", "select (id, name, email)"],
    ["plans", "select, insert, update, delete"],
    ["subscriptions", "select, update (plan_slug, status, current_period_end, on_trial, disabled_at, updated_at)"],
    ["invoices", "select"],
    ["platform_admins", "select, update"],
    ["admin_sessions", "select, insert, update, delete"],
    ["admin_challenges", "select, insert, update, delete"],
    // append-only: sem update/delete/truncate
    ["audit_logs", "select, insert"],
  ];
  for (const [table, privileges] of grants) {
    if (await tableExists(table)) await sql.unsafe(`grant ${privileges} on table "${table}" to ${adminRole}`);
    else console.warn(`tabela ${table} ainda não existe: grant pulado (rode de novo depois da migration).`);
  }
  // uso por empresa (só contagem): apenas id e organization_id das tabelas de canais/agentes, quando existirem
  for (const table of ["channels", "agents"]) {
    if ((await tableExists(table)) && (await columnExists(table, "organization_id"))) {
      await sql.unsafe(`grant select (id, organization_id) on table "${table}" to ${adminRole}`);
    }
  }
  console.log(`Papel ${adminRole} pronto (BYPASSRLS, privilégios mínimos).`);
}

await sql.end();
console.log(`Papel ${appRole} pronto (sem BYPASSRLS).`);
