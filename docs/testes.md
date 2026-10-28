# Testes

## Uma linha

```sh
pnpm test        # db + api + ai, com Postgres de teste
pnpm test:unit   # só os testes que não precisam de banco
```

`pnpm test` executa [`scripts/test-all.sh`](../scripts/test-all.sh), que:

1. **Recusa o banco de desenvolvimento.** Troca o nome do banco nas URLs de `packages/db/.env` e `apps/api/.env` por um banco **descartável** (padrão `duckzap_scratch_all`; mude com `TEST_DB_NAME`). O nome `duckzap` é recusado.
2. Liga as flags de integração (`CLIENTES_INTEGRATION`, `AGENDA_INTEGRATION`, `AGENDA_EXCLUSION_CONSTRAINT`, `ADMIN_INTEGRATION`, `CONVERSATIONS_INTEGRATION`, `CAMPAIGNS_ALLOW_DEV_DB`).
3. Força `LLM_PROVIDER=fake` e remove `LLM_API_KEY`: nenhum teste chama provedor real, mesmo que o `.env` tenha chave.
4. Roda `vitest` em `@duckzap/db`, `@duckzap/api` e `@duckzap/ai`.

Os testes de integração rodam cada caso numa transação desfeita no fim, mas alguns gravam de verdade (login, admin). Por isso o banco é descartável: pode ser apagado e recriado a qualquer hora. **Não rode dois `pnpm test` ao mesmo tempo no mesmo banco** (os resultados de um interferem no outro).

## Criar o banco descartável (uma vez)

Com o Postgres do Docker no ar e as senhas em `packages/db/.env`:

```sh
# 1) cria o banco vazio (use o papel dono do banco de desenvolvimento)
docker compose -f docker-compose.local.yml exec postgres psql -U duckzap -d postgres -c 'create database duckzap_scratch_all'
# 2) migrations + papéis + seed, apontando para ele (troque o nome do banco no fim da URL)
DATABASE_ADMIN_URL=postgres://duckzap:<senha>@127.0.0.1:5433/duckzap_scratch_all pnpm --filter @duckzap/db db:setup
```

Para recomeçar do zero: `drop database duckzap_scratch_all` e repita. Depois de uma migration nova, rode o passo 2 de novo.

## Filtrar

Argumentos extras vão ao vitest: `pnpm test contacts` (arquivos com "contacts" no caminho). `ONLY_PACKAGE=api pnpm test help` roda só o pacote da API. Pacote sem arquivo que case termina com "No test files found": é esperado ao filtrar.

## O que cada tipo de teste cobre

- **Unitários** (sem banco): regras puras, rotas com sessão simulada (`vi.mock` de `session/queries`), crypto, validação de ambiente, guardrails da IA.
- **Integração** (`*.integration.test.ts`, precisam do banco e da flag): casos de uso com RLS real, isolamento entre empresas, constraints.
- **Evals de IA** (`packages/ai/evals`): usam provedor fake; avaliação com modelo real é manual (`pnpm --filter @duckzap/api llm:smoke`, gasta tokens).

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml): o job `check` (typecheck + `pnpm test:unit`) sempre roda; o job `integration` sobe um Postgres de serviço (banco do próprio job), roda `db:setup` e os testes dos três pacotes.
