#!/usr/bin/env bash
# Confere o .env de produção ANTES de subir. Recusa (exit 1) se faltar variável obrigatória, se algum segredo ainda for
# o valor de exemplo/marcador, se uma configuração for perigosa em produção (Mailpit, IA "fake", 2FA desligado…) ou
# incompleta. Nunca imprime VALORES, só nomes de variáveis.
#
# Uso:  ./check-env.sh [arquivo]      (padrão: .env ao lado deste script)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
file="${1:-$here/.env}"
example="$here/.env.production.example"
errors=0
warnings=0

err() { echo "  ERRO   $*" >&2; errors=$((errors + 1)); }
warn() { echo "  AVISO  $*" >&2; warnings=$((warnings + 1)); }

[[ -f "$file" ]] || { echo "Arquivo $file não existe. Copie .env.production.example para .env e preencha." >&2; exit 1; }

# Lê KEY=valor sem executar o arquivo (valores com espaço, $, < ou aspas não quebram nada).
declare -A V=()      # valores do .env
declare -A EX=()     # valores do exemplo (incluindo os comentados "# KEY=valor" não: só linhas ativas)
load() { # $1 arquivo  $2 nome do array
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    if [[ "$2" == V ]]; then V["$key"]="$val"; else EX["$key"]="$val"; fi
  done < "$1"
}
load "$file" V
[[ -f "$example" ]] && load "$example" EX

val() { printf '%s' "${V[$1]-}"; }
has() { [[ -n "${V[$1]-}" ]]; }
placeholder() { [[ "$1" == *TROQUE* || "$1" == *CHANGE_ME* || "$1" == *changeme* ]]; }
# CHECK_ENV_ALLOW_LOCAL=1 só para testes locais da pilha (domínios .localhost, registro local); nunca na VPS.
allow_local="${CHECK_ENV_ALLOW_LOCAL:-0}"
# variáveis cujo valor NUNCA pode ser o do exemplo (as demais, como TLS_MODE, podem coincidir de propósito)
secret_vars=" POSTGRES_PASSWORD APP_DB_PASSWORD ADMIN_DB_PASSWORD EVOLUTION_DB_PASSWORD VALKEY_PASSWORD EVOLUTION_API_KEY BETTER_AUTH_SECRET ENCRYPTION_KEY LLM_API_KEY SMTP_URL BACKUP_AGE_RECIPIENT BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY "

echo "Conferindo $file"

# ── permissões do arquivo (segredos em texto puro) ──
if mode="$(stat -c '%a' "$file" 2>/dev/null)"; then
  [[ "$mode" =~ ^[0-7]*[0-7]00$ ]] || warn "permissões $mode no .env: rode  chmod 600 $file"
fi

# ── obrigatórias ──
required=(APP_DOMAIN ADMIN_DOMAIN ACME_EMAIL TLS_MODE IMAGE_REGISTRY
  POSTGRES_PASSWORD APP_DB_PASSWORD ADMIN_DB_PASSWORD EVOLUTION_DB_PASSWORD VALKEY_PASSWORD EVOLUTION_API_KEY
  BETTER_AUTH_SECRET ENCRYPTION_KEY LLM_PROVIDER LLM_API_KEY SMTP_URL MAIL_FROM SUPPORT_EMAIL
  BACKUP_AGE_RECIPIENT BACKUP_R2_ENDPOINT BACKUP_R2_BUCKET BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY)
for k in "${required[@]}"; do
  has "$k" || err "$k está vazia ou ausente."
done

# ── nada de marcador nem valor igual ao do exemplo ──
for k in "${required[@]}"; do
  has "$k" || continue
  v="$(val "$k")"
  if placeholder "$v"; then
    err "$k ainda tem o marcador de exemplo (TROQUE…)."
  elif [[ "$secret_vars" == *" $k "* && -n "${EX[$k]-}" && "$v" == "${EX[$k]}" ]]; then
    err "$k é igual ao valor do .env.production.example."
  fi
done

# ── segredos de senha: só hexadecimal/alfanumérico e longos ──
secrets=(POSTGRES_PASSWORD APP_DB_PASSWORD ADMIN_DB_PASSWORD EVOLUTION_DB_PASSWORD VALKEY_PASSWORD EVOLUTION_API_KEY)
for k in "${secrets[@]}"; do
  has "$k" || continue
  v="$(val "$k")"
  [[ "$v" =~ ^[A-Za-z0-9]+$ ]] || err "$k tem caracteres especiais (quebram as URLs de conexão): gere com  openssl rand -hex 24"
  (( ${#v} >= 32 )) || err "$k é curta (${#v} caracteres; mínimo 32): gere com  openssl rand -hex 24"
done
# senhas diferentes entre si (um vazamento não pode abrir tudo)
for ((i = 0; i < ${#secrets[@]}; i++)); do
  for ((j = i + 1; j < ${#secrets[@]}; j++)); do
    a="$(val "${secrets[i]}")"; b="$(val "${secrets[j]}")"
    [[ -n "$a" && "$a" == "$b" ]] && ! placeholder "$a" && err "${secrets[i]} e ${secrets[j]} têm o MESMO valor: use um valor diferente para cada."
  done
done

if has BETTER_AUTH_SECRET; then
  v="$(val BETTER_AUTH_SECRET)"
  (( ${#v} >= 48 )) || err "BETTER_AUTH_SECRET é curta (mínimo 48 caracteres): gere com  openssl rand -hex 32"
fi
if has ENCRYPTION_KEY && ! placeholder "$(val ENCRYPTION_KEY)"; then
  bytes="$(printf '%s' "$(val ENCRYPTION_KEY)" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
  [[ "$bytes" == "32" ]] || err "ENCRYPTION_KEY precisa ser 32 bytes em base64 (openssl rand -base64 32); esta tem $bytes bytes."
fi

# ── domínios ──
host_re='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
for k in APP_DOMAIN ADMIN_DOMAIN; do
  has "$k" || continue
  v="$(val "$k")"
  [[ "$v" =~ $host_re ]] || err "$k não parece um domínio válido (sem https://, sem barra, em minúsculas)."
  [[ "$allow_local" != 1 && ( "$v" == *localhost* || "$v" == *example* ) ]] && err "$k aponta para um domínio de teste."
done
[[ -n "$(val APP_DOMAIN)" && "$(val APP_DOMAIN)" == "$(val ADMIN_DOMAIN)" ]] && err "APP_DOMAIN e ADMIN_DOMAIN precisam ser diferentes."
has ACME_EMAIL && [[ "$(val ACME_EMAIL)" != *@*.* ]] && err "ACME_EMAIL não parece um e-mail."

# ── TLS ──
case "$(val TLS_MODE)" in
  auto) ;;
  origin)
    if [[ ! -s "$here/certs/origin.pem" || ! -s "$here/certs/origin.key" ]]; then
      err "TLS_MODE=origin, mas faltam $here/certs/origin.pem e/ou origin.key (certificado de origem da Cloudflare)."
    fi ;;
  "") ;;
  *) err "TLS_MODE deve ser 'auto' ou 'origin'." ;;
esac

case "$(val ORIGIN_LOCK)" in cloudflare|off|"") ;; *) err "ORIGIN_LOCK deve ser cloudflare ou off." ;; esac
[[ "$(val ORIGIN_LOCK)" == off ]] && warn "ORIGIN_LOCK=off: o Caddy atende qualquer IP; garanta no firewall da Hostinger que 80/443 só aceitam a Cloudflare."

# ── imagens ──
has IMAGE_REGISTRY && [[ "$(val IMAGE_REGISTRY)" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$ ]] \
  || err "IMAGE_REGISTRY inválido: use  ghcr.io/<usuario-github-em-minusculas>"

# ── IA ──
if has LLM_PROVIDER; then
  [[ "$(val LLM_PROVIDER)" == "fake" ]] && err "LLM_PROVIDER=fake não é permitido em produção (a API recusa subir)."
  [[ "$(val LLM_PROVIDER)" =~ ^(anthropic|openai|gemini|groq)$ ]] || err "LLM_PROVIDER desconhecido (anthropic, openai, gemini ou groq)."
fi

# ── e-mail: nada de Mailpit/local ──
if has SMTP_URL; then
  smtp="$(val SMTP_URL)"
  if [[ "$smtp" =~ (localhost|127\.0\.0\.1|mailpit|host\.docker\.internal|:1025|:1026) ]]; then
    err "SMTP_URL aponta para a caixa de e-mail de desenvolvimento (Mailpit/local). Use o SMTP real do provedor."
  fi
  [[ "$smtp" =~ ^smtps?:// ]] || err "SMTP_URL precisa começar com smtp:// ou smtps://."
fi
has MAIL_FROM && [[ "$(val MAIL_FROM)" == *duckchat.local* ]] && err "MAIL_FROM ainda usa o domínio de desenvolvimento (duckchat.local)."
has SUPPORT_EMAIL && [[ "$(val SUPPORT_EMAIL)" != *@*.* ]] && err "SUPPORT_EMAIL não parece um e-mail."

# ── segurança ──
for k in REQUIRE_2FA_FOR_ADMINS ADMIN_REQUIRE_ACTIVATION_CODE; do
  if has "$k"; then
    [[ "$(val "$k")" == "true" ]] || err "$k precisa ser true em produção."
  fi
done
[[ "$(val OPENAPI_PUBLIC)" == "true" ]] && err "OPENAPI_PUBLIC=true expõe a superfície da API; não use em produção."
[[ "$(val CAMPAIGNS_SCHEDULER)" == "off" ]] && warn "CAMPAIGNS_SCHEDULER=off: ninguém dispara as campanhas (não existe worker dedicado ainda). Deixe inline."
has ADMIN_IP_ALLOWLIST || warn "ADMIN_IP_ALLOWLIST vazio: o painel admin aceita qualquer IP (a Cloudflare Access ou a lista de IPs é fortemente recomendada)."

# ── mídia (R2): tudo ou nada; espelha a regra da API ──
media_set=0; media_missing=()
for k in MEDIA_STORAGE_ENDPOINT MEDIA_STORAGE_BUCKET MEDIA_STORAGE_ACCESS_KEY_ID MEDIA_STORAGE_SECRET_ACCESS_KEY; do
  if has "$k"; then media_set=$((media_set + 1)); else media_missing+=("$k"); fi
done
has MEDIA_STORAGE_PUBLIC_ENDPOINT && media_set=$((media_set + 1))
if (( media_set == 0 )); then
  warn "MEDIA_STORAGE_* não definido: envio e recebimento de imagens, documentos e áudios ficam DESLIGADOS."
elif (( ${#media_missing[@]} > 0 )); then
  err "Mídia incompleta (a API recusa subir assim): faltam ${media_missing[*]}."
else
  v="$(val MEDIA_STORAGE_ENDPOINT)"
  [[ "$v" == https://* ]] || err "MEDIA_STORAGE_ENDPOINT deve ser https:// em produção."
  has MEDIA_STORAGE_PUBLIC_ENDPOINT && [[ "$(val MEDIA_STORAGE_PUBLIC_ENDPOINT)" != https://* ]] && err "MEDIA_STORAGE_PUBLIC_ENDPOINT deve ser https:// (a CSP e o navegador exigem)."
  [[ "$v" == *localhost* || "$v" == *127.0.0.1* || "$v" == *minio* ]] && err "MEDIA_STORAGE_ENDPOINT aponta para o MinIO/local; em produção use o R2."
  for k in MEDIA_STORAGE_ENDPOINT MEDIA_STORAGE_BUCKET MEDIA_STORAGE_ACCESS_KEY_ID MEDIA_STORAGE_SECRET_ACCESS_KEY MEDIA_STORAGE_PUBLIC_ENDPOINT; do
    has "$k" && placeholder "$(val "$k")" && err "$k ainda tem marcador de exemplo."
  done
  [[ "$(val MEDIA_STORAGE_FORCE_PATH_STYLE)" == "true" ]] \
    || warn "MEDIA_STORAGE_FORCE_PATH_STYLE não é true: com o R2 as URLs assinadas usam <bucket>.<conta>.r2…, outra ORIGEM que a CSP do web precisa liberar (defina MEDIA_STORAGE_PUBLIC_ENDPOINT com ela)."
  warn "Mídia ligada: confirme o CORS do bucket R2 (PUT/GET/HEAD da origem https://$(val APP_DOMAIN)); veja docs/runbooks/deploy.md."
fi

# ── backup ──
if has BACKUP_AGE_RECIPIENT && ! placeholder "$(val BACKUP_AGE_RECIPIENT)"; then
  [[ "$(val BACKUP_AGE_RECIPIENT)" =~ ^age1[a-z0-9]{50,}$ ]] || err "BACKUP_AGE_RECIPIENT deve ser a chave PÚBLICA age (começa com age1…). Nunca a privada (AGE-SECRET-KEY)."
fi
[[ "$(val BACKUP_AGE_RECIPIENT)" == AGE-SECRET-KEY* ]] && err "BACKUP_AGE_RECIPIENT contém uma chave PRIVADA. Tire-a do servidor agora e gere outro par."
if has BACKUP_R2_ENDPOINT && ! placeholder "$(val BACKUP_R2_ENDPOINT)"; then
  [[ "$(val BACKUP_R2_ENDPOINT)" =~ ^https://[a-z0-9]+\.r2\.cloudflarestorage\.com$ ]] || warn "BACKUP_R2_ENDPOINT não parece um endpoint do R2 (https://<conta>.r2.cloudflarestorage.com)."
fi
if has BACKUP_R2_BUCKET && has MEDIA_STORAGE_BUCKET && [[ "$(val BACKUP_R2_BUCKET)" == "$(val MEDIA_STORAGE_BUCKET)" ]]; then
  err "BACKUP_R2_BUCKET é o mesmo bucket da mídia: use um bucket separado para os backups."
fi
has BACKUP_HEARTBEAT_URL || warn "BACKUP_HEARTBEAT_URL vazio: se o backup parar de rodar, ninguém será avisado."

echo
if (( errors > 0 )); then
  echo "RECUSADO: $errors erro(s), $warnings aviso(s). Corrija o .env e rode de novo." >&2
  exit 1
fi
echo "OK: nenhum erro ($warnings aviso(s))."
