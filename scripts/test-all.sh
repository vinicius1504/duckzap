#!/usr/bin/env bash
# Roda TODOS os testes do monorepo (db + api + ai) numa linha: `pnpm test`.
#
# Os testes de integração escrevem no Postgres. Por isso este script NUNCA usa o banco de desenvolvimento
# (`duckzap`): ele troca o nome do banco nas URLs de packages/db/.env e apps/api/.env por um banco DESCARTÁVEL
# (padrão `duckzap_scratch_all`, mude com TEST_DB_NAME). Esse banco precisa existir e estar migrado/semeado:
#
#   TEST_DB_NAME=duckzap_scratch_all pnpm test:db:prepare      # cria (se faltar), migra, cria papéis e semeia
#
# Variáveis:
#   TEST_DB_NAME   nome do banco descartável (padrão duckzap_scratch_all; "duckzap" é recusado)
#   ONLY_PACKAGE   roda só um pacote (db, api ou ai)
#   UNIT_ONLY=1    só os testes sem banco (é o que a CI faz sem serviço Postgres)
#   PREPARE=1      prepara o banco antes (equivale a `pnpm test:db:prepare`)
#
# Argumentos extras vão ao vitest de cada pacote (ex.: `pnpm test contacts` filtra por nome de arquivo;
# pacote sem arquivo que case encerra com erro "No test files found", o que é esperado ao filtrar).
#
# Provedor de IA nos testes é sempre `fake`: nenhuma chamada real, mesmo que o .env tenha uma chave.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

test_db="${TEST_DB_NAME:-duckzap_scratch_all}"
if [[ "$test_db" == "duckzap" || -z "$test_db" ]]; then
  echo "Recusado: TEST_DB_NAME=$test_db é o banco de desenvolvimento. Use um banco descartável." >&2
  exit 1
fi
if [[ ! "$test_db" =~ ^[a-z0-9_]+$ ]]; then
  echo "TEST_DB_NAME inválido (use letras minúsculas, números e _)." >&2
  exit 1
fi

# Lê KEY=valor de um arquivo .env sem executá-lo (valores com espaço, < ou $ não quebram).
env_value() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 0
  line="$(grep -m1 -E "^${key}=" "$file" || true)"
  line="${line#"${key}="}"
  line="${line%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  printf '%s' "$line"
}

# troca o nome do banco no fim da URL: postgres://u:p@host:5433/duckzap?x=y -> .../<test_db>?x=y
swap_db() { printf '%s' "$1" | sed -E "s#/[^/?]+(\?.*)?\$#/${test_db}\1#"; }

export_db_url() {
  local name="$1" value
  value="$(env_value apps/api/.env "$name")"
  [[ -n "$value" ]] || value="$(env_value packages/db/.env "$name")"
  if [[ -n "$value" ]]; then export "$name=$(swap_db "$value")"; fi
}

if [[ "${UNIT_ONLY:-0}" != "1" ]]; then
  # papel do app (sem BYPASSRLS), papel admin do painel e dono do schema (migrations/limpeza)
  export_db_url DATABASE_URL
  export_db_url ADMIN_DATABASE_URL
  owner="$(env_value packages/db/.env DATABASE_ADMIN_URL)"
  if [[ -n "$owner" ]]; then export DATABASE_ADMIN_URL="$(swap_db "$owner")"; fi

  for needed in DATABASE_URL DATABASE_ADMIN_URL; do
    if [[ -z "${!needed:-}" ]]; then
      echo "Falta $needed (packages/db/.env ou apps/api/.env). Use UNIT_ONLY=1 para rodar só os testes sem banco." >&2
      exit 1
    fi
  done

  # segredos de teste: os do .env local, ou valores aleatórios (nunca vão para produção)
  [[ -n "${ENCRYPTION_KEY:-}" ]] || export ENCRYPTION_KEY="$(env_value apps/api/.env ENCRYPTION_KEY)"
  [[ -n "${ENCRYPTION_KEY:-}" ]] || export ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  [[ -n "${BETTER_AUTH_SECRET:-}" ]] || export BETTER_AUTH_SECRET="$(env_value apps/api/.env BETTER_AUTH_SECRET)"
  [[ -n "${BETTER_AUTH_SECRET:-}" ]] || export BETTER_AUTH_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"

  export CLIENTES_INTEGRATION=1 AGENDA_INTEGRATION=1 AGENDA_EXCLUSION_CONSTRAINT=1 ADMIN_INTEGRATION=1 \
         CONVERSATIONS_INTEGRATION=1 NOTIFICATIONS_INTEGRATION=1 CAMPAIGNS_ALLOW_DEV_DB=1 CAMPAIGNS_INTEGRATION=1 CHANNELS_INTEGRATION=1 \
         AGENTS_INTEGRATION=1 SETTINGS_INTEGRATION=1 TEAM_INTEGRATION=1
  echo "Banco de teste (descartável): ${test_db}"
else
  echo "UNIT_ONLY=1: sem banco."
  unset DATABASE_URL ADMIN_DATABASE_URL DATABASE_ADMIN_URL
fi

# IA sempre fake nos testes; chaves reais do .env não são lidas aqui
export LLM_PROVIDER=fake
unset LLM_API_KEY LLM_FALLBACK_PROVIDER
export NODE_ENV=test

status=0
packages=(@duckzap/db @duckzap/api @duckzap/ai)
if [[ -n "${ONLY_PACKAGE:-}" ]]; then packages=("@duckzap/${ONLY_PACKAGE}"); fi
for pkg in "${packages[@]}"; do
  echo
  echo "=== testes de $pkg ==="
  pnpm --filter "$pkg" test "$@" || status=$?
done

exit "$status"
