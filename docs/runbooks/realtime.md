# Runbook — servidor de tempo real (`apps/realtime`)

Servidor WebSocket (`ws`) que avisa o navegador de que "algo mudou" (mensagem nova, conversa assumida, canal caiu…). Os eventos são **só avisos com ids**: nunca levam texto, nome nem telefone. O front busca o dado pela API normal, que aplica permissão e visibilidade. Contrato: `packages/contracts/src/realtime.ts`.

## Como funciona

```
API/worker ──PUBLISH rt:org:<empresa>──▶ Valkey ──SUBSCRIBE──▶ apps/realtime ──WebSocket──▶ navegador (/ws)
```

1. **Conexão.** O navegador abre `ws(s)://<host>/ws` mandando o cookie de sessão sozinho. Antes de aceitar o socket o servidor:
   1. confere o cabeçalho `Origin` contra `WEB_ORIGINS` (senão **HTTP 403**);
   2. confere o limite de conexões por IP (**429**);
   3. chama `GET ${API_INTERNAL_URL}/v1/me` repassando o `Cookie` e com `Origin` = primeira origem de `WEB_ORIGINS` (timeout de 5 s). Dali tira `organization.id` e `user.id`. **Nada que o cliente mande é usado para decidir empresa ou usuário** (não há query string, token nem mensagem que escolha a empresa);
   4. resultado: sessão válida → aceita; **401/sem cookie → fecha com 4401**; conta suspensa (`isAccountSuspended`: `expired`/`canceled`) → **4402**; API fora do ar/5xx/timeout/resposta inesperada → **HTTP 503** (o cliente tenta de novo); mais de 10 conexões do mesmo usuário → **429**.
   5. Para 4401/4402 o socket é aceito apenas para entregar o código de fechamento ao navegador; nada é assinado nem enviado.
2. **Pronto.** Depois de assinar o canal da empresa, o servidor manda `{"type":"ready"}`.
3. **Fan-out.** Uma única conexão de assinatura ao Valkey (`REDIS_URL`). O canal `rt:org:<empresa>` é assinado **sob demanda** (quando entra o primeiro socket da empresa) e cancelado quando sai o último. Cada mensagem é validada com `realtimeEnvelopeSchema`; inválida é descartada (log só com contagem). O envelope tem de declarar a **mesma** empresa do canal em que chegou; divergência (envelope forjado) é descartada. O que passa é entregue **somente** aos sockets daquela empresa, como `{type:"event", id, at, event}`. Campos fora do contrato não atravessam.
4. **Heartbeat.** A cada 25 s o servidor manda `{"type":"ping"}`; o cliente responde `{"type":"pong"}`. Quem ficar 60 s sem pong é derrubado. Mensagens do cliente: no máximo 1 KB, 20 por 10 s, e só `pong` (qualquer outra coisa fecha com 1008; binário, 1003; grande demais, 1009).
5. **Revalidação.** A cada 5 min cada conexão é revalidada na API: sessão revogada/desativada → 4401, conta suspensa → 4402, trocou de empresa ativa → 4401 (o front reconecta já na empresa certa). Se a API estiver fora, as conexões abertas **não** são derrubadas.
6. **Reconexão do Valkey.** `autoResubscribe` do ioredis refaz as assinaturas dos canais ativos. (`enableReadyCheck` fica desligado: o `INFO` do ready check é proibido em modo assinante.) Eventos publicados enquanto o servidor estava desconectado do Valkey se perdem (Pub/Sub não guarda); o front deve reconsultar a API ao reconectar.
7. **Desligamento (SIGINT/SIGTERM).** Fecha os sockets com 4503 (`serverShuttingDown`), encerra o Valkey e sai; força saída em 10 s.

Códigos de fechamento: `4401` sem sessão · `4402` conta suspensa · `4403` origem proibida (reservado; a recusa de origem acontece antes do upgrade, em HTTP 403) · `4503` servidor desligando · `1008` mensagem inválida/excesso · `1013` não conseguiu assinar o canal, tente de novo.

## Variáveis de ambiente

Modelo em `apps/realtime/.env.example`. O processo **não sobe** com configuração inválida (a mensagem lista os campos, nunca os valores).

| Variável | Padrão | Observação |
|---|---|---|
| `REALTIME_PORT` | `4001` | |
| `REALTIME_HOST` | `0.0.0.0` | `127.0.0.1` se o Caddy roda na mesma máquina fora de container |
| `REDIS_URL` | — (obrigatória) | Valkey: `redis://:<VALKEY_PASSWORD>@127.0.0.1:6380` em dev |
| `API_INTERNAL_URL` | `http://127.0.0.1:4000` | rede interna; obrigatória em produção |
| `WEB_ORIGINS` | `http://localhost:3000` | lista por vírgula, `http(s)://host[:porta]` sem barra final; obrigatória em produção. Igual ao `WEB_ORIGINS` da API |
| `REALTIME_TRUST_PROXY` | `false` | `true` só atrás de proxy confiável: o IP do cliente passa a ser o **último** item de `X-Forwarded-For` |
| `REALTIME_MAX_CONNECTIONS_PER_USER` | `10` | |
| `REALTIME_MAX_CONNECTIONS_PER_IP` | `50` | atrás de proxy sem `TRUST_PROXY` todos têm o mesmo IP: ligue `TRUST_PROXY` |
| `REALTIME_MAX_MESSAGE_BYTES` | `1024` | |
| `REALTIME_CLIENT_MESSAGES_PER_10S` | `20` | |
| `REALTIME_PING_INTERVAL_MS` | `25000` | |
| `REALTIME_PONG_TIMEOUT_MS` | `60000` | maior que o intervalo de ping |
| `REALTIME_REVALIDATE_INTERVAL_MS` | `300000` | |
| `REALTIME_AUTH_TIMEOUT_MS` | `5000` | timeout da chamada `GET /v1/me` |

## Portas

| Serviço | Porta |
|---|---|
| web | 3000 |
| API | 4000 |
| **realtime** | **4001** (`/ws` e `/health`) |
| Valkey (host, dev) | 6380 |

## Rodar e testar

```bash
cd apps/realtime
cp .env.example .env        # preencha a senha do Valkey (VALKEY_PASSWORD do .env da raiz)
pnpm dev                    # tsx watch, lê .env
```

Em dev, o navegador em `http://localhost:3000` conecta direto em `ws://localhost:4001/ws`; o cookie de sessão de `localhost` também é enviado à porta 4001 (cookies não isolam por porta), e a `Origin` `http://localhost:3000` está em `WEB_ORIGINS`.

**Saúde:** `curl http://localhost:4001/health` → `{"status":"ok","redis":"up","connections":0}`. Não exponha `/health` publicamente (veja o Caddy abaixo).

**Teste manual com `redis-cli`** (com o front aberto e logado, ou com um cliente `ws` que envie o cookie e a `Origin`):

```bash
# substitua <ORG_ID> pelo organization.id da sua sessão (GET /v1/me)
redis-cli -p 6380 -a "$VALKEY_PASSWORD" PUBLISH rt:org:<ORG_ID> \
  '{"v":1,"id":"teste-1","organizationId":"<ORG_ID>","at":"2026-01-01T00:00:00.000Z","event":{"type":"home.invalidate"}}'
```

O retorno é o número de assinantes (1 se há conexões da empresa; 0 se ninguém conectado, porque o canal é assinado sob demanda). Um envelope cujo `organizationId` não bate com o canal é descartado (isso é proposital).

**Testes automatizados:**

```bash
cd apps/realtime
REDIS_URL="redis://:<VALKEY_PASSWORD>@127.0.0.1:6380" npx vitest run   # inclui a integração com o Valkey real
npx vitest run                                                        # sem REDIS_URL a integração é pulada
```

Cobrem: origem, autenticação (inválida/suspensa/API fora), **isolamento entre empresas** (incluindo envelope forjado), assinatura sob demanda, heartbeat, limites por usuário/IP, mensagens inválidas, revalidação, desligamento, configuração e o cliente da API. A integração publica no Valkey real, recebe por um cliente `ws` real e confere a reassinatura após derrubar a conexão.

## Produção atrás do Caddy

O Caddy é o único serviço exposto (`wss://<domínio>/ws`). Só o caminho `/ws` é encaminhado (`/health` fica interno, para o healthcheck do compose). O Caddy já faz o upgrade de WebSocket sozinho no `reverse_proxy`.

```caddyfile
duckchat.exemplo.com.br {
	# cookie de sessão e app no mesmo domínio: o navegador manda o cookie ao /ws sem CORS
	handle /ws {
		reverse_proxy realtime:4001 {
			# conexões longas: não derrubar na troca de configuração
			stream_close_delay 5m
		}
	}
	handle /api/* {
		reverse_proxy api:4000
	}
	handle {
		reverse_proxy web:3000
	}
}
```

- **Variáveis em produção:** `WEB_ORIGINS=https://duckchat.exemplo.com.br` (a mesma origem que o navegador envia), `API_INTERNAL_URL=http://api:4000`, `REDIS_URL` com a senha do Valkey, `REALTIME_HOST=0.0.0.0`.
- **IP do cliente / limite por IP:** o Caddy envia `X-Forwarded-For` e o servidor, com `REALTIME_TRUST_PROXY=true`, usa o **último** item (o que o Caddy acrescentou). Com a Cloudflare na frente, configure no Caddy os IPs da Cloudflare como `trusted_proxies` e `client_ip_headers CF-Connecting-IP` (bloco `servers` global); sem isso o Caddy enxerga só o IP da Cloudflare. Ligue `REALTIME_TRUST_PROXY=true` **apenas** se a porta 4001 não for alcançável por ninguém além do Caddy (rede interna do compose, sem `ports:` publicado): senão um cliente forja o cabeçalho.
- **Cloudflare:** WebSockets são suportados no plano gratuito; conexões ociosas por mais de ~100 s podem ser cortadas, por isso o ping de 25 s.
- **Healthcheck do compose:** `wget -qO- http://127.0.0.1:4001/health`.
- **Escala:** uma instância cobre o orçamento de ~150 MB do §7. Para mais de uma, nada muda: cada instância assina os canais das empresas que ela atende (o Pub/Sub do Valkey entrega a todas).

## Incidentes comuns

| Sintoma | Causa provável |
|---|---|
| Front reconecta em loop com 503 | API fora do ar ou `API_INTERNAL_URL` errada (o servidor não consegue chamar `/v1/me`) |
| 403 no upgrade | `Origin` não está em `WEB_ORIGINS` (inclusive `http` vs `https`, `www`, porta) |
| Fecha com 4401 logo após conectar | cookie não chegou ao `/ws` (domínio/proxy) ou sessão expirada |
| Conectado mas sem eventos | a API não está publicando em `rt:org:<id>` com o `organizationId` igual ao do canal (envelopes divergentes são descartados), ou Valkey desconectado (`/health` → `redis: down`) |
| 429 | limite por usuário (10) ou por IP; atrás do Caddy sem `REALTIME_TRUST_PROXY` todos dividem um IP |
