# SQL que o Drizzle não gera (Painel Admin)

Aplicar na migration de integração (depois das tabelas de `admin.ts`). Tudo idempotente.
`scripts/setup-roles.ts` também cria o trigger e faz os grants/revokes (rodar `db:roles` depois da migration basta);
o SQL abaixo fica aqui para quem preferir colocá-lo na própria migration.

## 1. Backfill das colunas novas de `subscriptions`

```sql
update subscriptions set on_trial = true where status = 'trial' and on_trial = false;
```

## 2. `audit_logs` só aceita INSERT (vale até para o dono)

```sql
create or replace function audit_logs_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs é append-only' using errcode = '42501';
end $$;

drop trigger if exists audit_logs_no_update_delete on audit_logs;
create trigger audit_logs_no_update_delete
  before update or delete on audit_logs
  for each row execute function audit_logs_immutable();

drop trigger if exists audit_logs_no_truncate on audit_logs;
create trigger audit_logs_no_truncate
  before truncate on audit_logs
  for each statement execute function audit_logs_immutable();
```

`audit_logs` não referencia outras tabelas de propósito (apagar uma empresa/plano não apaga o histórico).

## 3. Papéis (feito por `scripts/setup-roles.ts`)

- `duckzap_app`: `revoke all` em `platform_admins`, `admin_sessions`, `admin_challenges`, `audit_logs`, `invoices`
  (o script revoga de novo a cada execução, depois dos grants gerais).
- `duckzap_admin` (LOGIN, NOSUPERUSER, BYPASSRLS): ver o script para a lista exata de grants.
  Em `user` só as colunas `id, name, email`; em `channels`/`agents` (se existirem) só `id, organization_id`
  (para contar uso). Sem acesso a mensagens, contatos, conversas etc.
