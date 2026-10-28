#!/bin/sh
# Backup do DuckChat: pg_dump -> cifra com age (chave PÚBLICA) -> Cloudflare R2 (rclone). INSTRUCTIONS.md §7.4.
# Roda dentro do contêiner "backup" (deploy/backup.Dockerfile) sem cron do sistema (§7.5): o modo "loop" dorme até a hora marcada.
#
#   backup.sh loop    (padrão) todo dia às BACKUP_HOUR (fuso TZ), para sempre
#   backup.sh once    uma execução agora (teste/manual):  docker compose exec backup /usr/local/bin/backup.sh once
#
# Tudo vem de variáveis de ambiente (ver .env.production.example, seção 8). Nada é gravado em disco: o dump passa por pipe
# (pg_dump | age | rclone rcat), então nem o texto puro nem o arquivo cifrado ocupam disco ou memória do contêiner.
# Só a chave PÚBLICA age está aqui: quem invadir o servidor não consegue abrir backups antigos.
set -eu
# sh do Alpine (busybox ash) aceita pipefail
set -o pipefail

: "${BACKUP_AGE_RECIPIENT:?defina BACKUP_AGE_RECIPIENT (chave pública age)}"
: "${BACKUP_DATABASES:=duckzap evolution}"
: "${BACKUP_HOUR:=03:30}"
: "${BACKUP_RETENTION_DAYS:=30}"
: "${PGHOST:?}"; : "${PGUSER:?}"; : "${PGPASSWORD:?}"
# BACKUP_REMOTE permite apontar para outro destino do rclone (testes: um diretório local). Padrão: o bucket do R2.
if [ -z "${BACKUP_REMOTE:-}" ]; then
  : "${BACKUP_R2_ENDPOINT:?}"; : "${BACKUP_R2_BUCKET:?}"; : "${BACKUP_R2_ACCESS_KEY_ID:?}"; : "${BACKUP_R2_SECRET_ACCESS_KEY:?}"
  # configuração do rclone só por variáveis de ambiente (nenhum rclone.conf em disco)
  export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ENDPOINT="$BACKUP_R2_ENDPOINT"
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY"
  # o token do R2 costuma não poder criar bucket: não tente
  export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  BACKUP_REMOTE="r2:${BACKUP_R2_BUCKET}"
fi
PREFIX="duckchat"
export RCLONE_S3_UPLOAD_CONCURRENCY=2 RCLONE_S3_CHUNK_SIZE=8M RCLONE_CACHE_DIR=/tmp/rclone

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# vários destinatários age separados por vírgula (ex.: a chave do dono e a de um segundo guardião)
age_args=""
for r in $(printf '%s' "$BACKUP_AGE_RECIPIENT" | tr ',' ' '); do age_args="$age_args -r $r"; done

heartbeat() { # $1 = "" (ok) ou "/fail"
  [ -n "${BACKUP_HEARTBEAT_URL:-}" ] || return 0
  curl -fsS -m 15 --retry 2 -o /dev/null "${BACKUP_HEARTBEAT_URL}$1" || log "aviso: heartbeat não enviado"
}

# envia stdin cifrado para $1 (caminho relativo ao bucket) e confere que o objeto existe e não é vazio
upload() {
  dest="$BACKUP_REMOTE/$PREFIX/$1"
  # shellcheck disable=SC2086
  age $age_args | rclone rcat "$dest"
  size="$(rclone size --json "$dest" 2>/dev/null | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')"
  [ "${size:-0}" -gt 200 ] || { log "ERRO: $1 chegou com ${size:-0} bytes"; return 1; }
  log "ok: $1 (${size} bytes cifrados)"
}

# nota: esta função roda dentro de "if", onde o set -e não vale; por isso cada etapa tem "|| return 1" explícito
run_once() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  day="$(date -u +%Y-%m-%d)"
  for db in $BACKUP_DATABASES; do
    obj="$day/$db-$ts.dump.age"
    # -Fc: formato custom (compactado, restaurável por partes com pg_restore)
    if ! pg_dump --dbname "$db" --format=custom --compress=6 --no-password | upload "$obj"; then
      log "ERRO no dump de $db; apagando o objeto incompleto"
      rclone deletefile "$BACKUP_REMOTE/$PREFIX/$obj" 2>/dev/null || true
      return 1
    fi
  done
  # papéis (sem os bancos): necessário para restaurar donos e permissões; a senha dos papéis é refeita pelo db:roles
  obj="$day/globals-$ts.sql.age"
  if ! pg_dumpall --globals-only --no-password | upload "$obj"; then
    rclone deletefile "$BACKUP_REMOTE/$PREFIX/$obj" 2>/dev/null || true
    return 1
  fi

  # retenção: só depois de os envios de hoje terem dado certo, para uma falha não apagar o histórico sem repor
  rclone delete "$BACKUP_REMOTE/$PREFIX" --min-age "${BACKUP_RETENTION_DAYS}d" 2>&1 || log "aviso: limpeza de backups antigos falhou"
  rclone rmdirs "$BACKUP_REMOTE/$PREFIX" --leave-root >/dev/null 2>&1 || true
  log "concluído (retenção ${BACKUP_RETENTION_DAYS} dias)"
}

attempt() {
  if ( run_once ); then heartbeat ""; else log "FALHOU"; heartbeat "/fail"; return 1; fi
}

secs_until() { # segundos até a próxima ocorrência de HH:MM (fuso do contêiner)
  now="$(date +%s)"
  target="$(date -d "$(date +%Y-%m-%d) $1:00" +%s)"
  [ "$target" -gt "$now" ] || target=$((target + 86400))
  echo $((target - now))
}

case "${1:-loop}" in
  once) attempt ;;
  loop)
    case "$BACKUP_HOUR" in [0-2][0-9]:[0-5][0-9]) ;; *) log "BACKUP_HOUR inválido ($BACKUP_HOUR); use HH:MM"; exit 1 ;; esac
    log "agendado todo dia às $BACKUP_HOUR (fuso ${TZ:-UTC}); bancos: $BACKUP_DATABASES"
    trap 'log "encerrando"; exit 0' TERM INT
    while true; do
      wait_s="$(secs_until "$BACKUP_HOUR")"
      log "próxima execução em ${wait_s}s"
      sleep "$wait_s" &
      wait $!
      attempt || true
    done ;;
  *) echo "uso: backup.sh [loop|once]" >&2; exit 2 ;;
esac
