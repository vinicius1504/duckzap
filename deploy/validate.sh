#!/usr/bin/env bash
# Valida os arquivos de deploy SEM servidor e SEM segredos: gera um .env de valores falsos num arquivo temporário e confere
#  1) o check-env.sh aceita um .env bem preenchido e RECUSA o exemplo;  2) docker compose config resolve;
#  3) caddy validate aprova o Caddyfile;  4) sintaxe dos scripts.  Precisa de docker. Usado pela CI e à mão.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
h() { openssl rand -hex "${1:-24}"; }

cat > "$tmp/env" <<EOT
APP_DOMAIN=app.meudominio.com.br
ADMIN_DOMAIN=admin.meudominio.com.br
ACME_EMAIL=ops@meudominio.com.br
TLS_MODE=auto
IMAGE_REGISTRY=ghcr.io/meu-usuario
POSTGRES_PASSWORD=$(h)
APP_DB_PASSWORD=$(h)
ADMIN_DB_PASSWORD=$(h)
EVOLUTION_DB_PASSWORD=$(h)
VALKEY_PASSWORD=$(h)
EVOLUTION_API_KEY=$(h)
BETTER_AUTH_SECRET=$(h 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
LLM_PROVIDER=anthropic
LLM_API_KEY=sk-ant-falsa-so-para-validar
SMTP_URL=smtps://usuario:senha@smtp.provedor-de-teste.net:465
MAIL_FROM=DuckChat <nao-responda@meudominio.com.br>
SUPPORT_EMAIL=suporte@meudominio.com.br
BACKUP_AGE_RECIPIENT=age1$(printf 'q%.0s' $(seq 1 58))
BACKUP_R2_ENDPOINT=https://abc123.r2.cloudflarestorage.com
BACKUP_R2_BUCKET=bucket-de-backup
BACKUP_R2_ACCESS_KEY_ID=chave
BACKUP_R2_SECRET_ACCESS_KEY=segredo
EOT
chmod 600 "$tmp/env"

echo "1) check-env aceita um .env válido"
"$here/check-env.sh" "$tmp/env" >/dev/null 2>&1
echo "   check-env recusa o exemplo"
if "$here/check-env.sh" "$here/.env.production.example" >/dev/null 2>&1; then echo "ERRO: o exemplo foi aceito" >&2; exit 1; fi

echo "2) docker compose config"
cp "$tmp/env" "$tmp/.env"
IMAGE_TAG=validacao docker compose -f "$here/docker-compose.prod.yml" --env-file "$tmp/.env" config -q

echo "3) caddy validate"
MSYS_NO_PATHCONV=1 docker run --rm -v "$here/caddy:/etc/caddy:ro" \
  -e APP_DOMAIN=app.meudominio.com.br -e ADMIN_DOMAIN=admin.meudominio.com.br -e ACME_EMAIL=ops@meudominio.com.br \
  -e TLS_MODE=auto -e ORIGIN_LOCK=cloudflare -e MAX_BODY_SIZE=32MB \
  caddy:2.11.7-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1

echo "4) sintaxe dos scripts"
for f in check-env.sh deploy.sh cloudflare-ips.sh validate.sh; do bash -n "$here/$f"; done
sh -n "$here/backup.sh"
echo "OK: arquivos de deploy válidos."
