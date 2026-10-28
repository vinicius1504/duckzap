#!/usr/bin/env bash
# Operação do DuckChat NA VPS (rodado pelo GitHub Actions por SSH ou por você). Fica em /opt/duckchat/deploy.
#
#   ./deploy.sh up <tag>      confere o .env, baixa as imagens <tag> e sobe tudo; espera ficar saudável
#   ./deploy.sh rollback      volta para a tag anterior (a que estava no ar antes do último "up")
#   ./deploy.sh status        tag atual e estado dos serviços
#   ./deploy.sh logs [servico] [linhas]
#
# <tag> é o SHA completo do commit (a tag das imagens no GHCR). Nada é construído aqui: as imagens só são baixadas.
# ATENÇÃO ao rollback: as migrations só andam para frente. Voltar o código para uma versão antiga funciona quando a
# migration nova foi compatível com a anterior (acrescentar coluna/tabela). Se não foi, restaure o backup (docs/runbooks/restore.md).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
state=".deploy"; mkdir -p "$state"
dc() { IMAGE_TAG="$TAG" docker compose -f docker-compose.prod.yml "$@"; }
current() { cat "$state/current-tag" 2>/dev/null || true; }

health_check() {
  # 1) todos os serviços saudáveis (o --wait do compose já esperou); 2) a API responde por dentro; 3) o Caddy serve o app
  dc exec -T api node -e "fetch('http://127.0.0.1:4000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  local app_domain port
  app_domain="$(grep -E '^APP_DOMAIN=' .env | cut -d= -f2-)"; port="$(grep -E '^HTTPS_PORT=' .env | cut -d= -f2- || true)"
  # -k: com o certificado de origem da Cloudflare o curl local não confia nele; só importa que o Caddy responda
  curl -fsSk -o /dev/null -m 15 --resolve "${app_domain}:${port:-443}:127.0.0.1" "https://${app_domain}:${port:-443}/entrar"
}

case "${1:-}" in
  up)
    TAG="${2:?uso: ./deploy.sh up <tag>}"
    [[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo "tag inválida"; exit 2; }
    ./check-env.sh
    prev="$(current)"
    echo "==> Baixando imagens $TAG"
    dc pull --quiet
    echo "==> Subindo (migrations rodam antes da API)"
    if dc up -d --remove-orphans --wait --wait-timeout 300; then
      if health_check; then
        [[ -n "$prev" && "$prev" != "$TAG" ]] && echo "$prev" > "$state/previous-tag"
        echo "$TAG" > "$state/current-tag"; rm -f "$state/failed"
        docker image prune -f >/dev/null 2>&1 || true
        echo "==> OK: $TAG no ar."; dc ps; exit 0
      fi
    fi
    echo "==> FALHOU. Estado dos serviços e últimos logs:" >&2
    dc ps -a >&2 || true
    dc logs --tail 40 api migrate web >&2 || true
    echo "Se a versão anterior estava boa:  ./deploy.sh rollback" >&2
    touch "$state/failed"   # a última versão BOA continua em current-tag
    exit 1 ;;
  rollback)
    # se o último "up" falhou, a versão boa é a current-tag; se deu certo mas você quer voltar, é a previous-tag
    if [[ -f "$state/failed" ]]; then TAG="$(current)"; else TAG="$(cat "$state/previous-tag" 2>/dev/null || true)"; fi
    [[ -n "$TAG" ]] || { echo "Não sei qual era a versão anterior (.deploy/previous-tag vazio). Informe:  ./deploy.sh up <tag>"; exit 1; }
    echo "==> Voltando para $TAG"
    exec "$0" up "$TAG" ;;
  status)
    TAG="$(current)"; echo "Versão no ar: ${TAG:-desconhecida}  (anterior: $(cat "$state/previous-tag" 2>/dev/null || echo -))"
    dc ps ;;
  logs)
    TAG="$(current)"; dc logs --tail "${3:-100}" -f "${2:-}" ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
