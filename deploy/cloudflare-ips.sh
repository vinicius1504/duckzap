#!/usr/bin/env bash
# Imprime as faixas de IP ATUAIS da Cloudflare (https://www.cloudflare.com/ips/) em três formatos úteis.
# Não altera nada sozinho. Rode quando quiser conferir se o Caddyfile/firewall estão em dia (a Cloudflare muda isso raramente).
#
#   ./cloudflare-ips.sh caddy   linha para "trusted_proxies static …" do deploy/caddy/Caddyfile
#   ./cloudflare-ips.sh ufw     comandos ufw que liberam 80/443 SÓ para a Cloudflare (revise antes de executar, como root)
#   ./cloudflare-ips.sh list    uma faixa por linha
set -euo pipefail
v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
[[ -n "$v4" && -n "$v6" ]] || { echo "Não consegui baixar as listas da Cloudflare." >&2; exit 1; }
all="$(printf '%s\n%s\n' "$v4" "$v6" | tr -d '\r')"
case "${1:-list}" in
  list) echo "$all" ;;
  caddy) echo "trusted_proxies static $(echo "$all" | tr '\n' ' ')" ;;
  ufw)
    echo "# Remove regras antigas 80/443 abertas ao mundo e libera só a Cloudflare. Revise e execute como root."
    echo "ufw delete allow 80/tcp || true"; echo "ufw delete allow 443/tcp || true"
    while read -r cidr; do
      [[ -n "$cidr" ]] && echo "ufw allow proto tcp from $cidr to any port 80,443 comment 'cloudflare'"
    done <<< "$all"
    echo "ufw reload" ;;
  *) echo "uso: $0 [caddy|ufw|list]" >&2; exit 2 ;;
esac
