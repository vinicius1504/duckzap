# Runbook — colocar o DuckChat no ar (VPS Hostinger + Docker + Caddy + Cloudflare)

Para quem opera o sistema (o dono). Escrito para quem não é técnico avançado: cada passo diz **onde** rodar (seu computador ou a VPS) e **o que esperar**. Complementa o INSTRUCTIONS.md §7.

> **Leia primeiro: o que foi e o que não foi testado.** Os arquivos desta pasta (`deploy/`, os Dockerfiles, os workflows) foram validados **só no Docker do computador de desenvolvimento**: as imagens constroem, a pilha inteira sobe com valores falsos, os healthchecks ficam verdes, o Caddy roteia certo, as migrations rodam num banco vazio, o backup cifra e restaura. **Nada disto foi executado numa VPS real, com a Cloudflare, com o R2, com o GitHub Actions nem com certificado de verdade.** Espere pequenos ajustes no primeiro deploy e faça-o com calma, antes de abrir para clientes.

## Visão geral

```
navegador ─▶ Cloudflare (DNS, proxy, WAF) ─▶ VPS: Caddy :80/:443 ─┬─▶ web      (app das empresas)
                                                                  ├─▶ admin    (painel super admin)
                                                                  ├─▶ api      (só /api/v1/auth, /api/v1/me, webhooks)
                                                                  └─▶ realtime (WebSocket /ws)
        rede interna (sem porta pública): postgres · valkey · evolution (WhatsApp por QR) · api · migrate · backup
        mídia (imagens/áudios/documentos): o NAVEGADOR envia e baixa direto do Cloudflare R2 (não passa pela VPS)
```

- **Imagens** são construídas pelo GitHub Actions e publicadas no GHCR; a VPS **só baixa** (nunca constrói).
- **Deploy** = GitHub Actions aprovado por você → SSH → `./deploy.sh up <commit>`.
- **Segredos** moram só no arquivo `.env` da VPS e nos "Secrets" do GitHub. Nunca no código nem nas imagens.
- **Domínios** (exemplo): `app.seudominio.com.br` (empresas) e `admin.seudominio.com.br` (painel).

## 1. Antes de começar (pré-requisitos)

| O quê | Para quê | Observação |
|---|---|---|
| Um domínio na **Cloudflare** | DNS, proxy, HTTPS ao cliente | Plano Free serve para começar |
| VPS **Hostinger KVM 1** (4 GB), datacenter **Brasil**, Ubuntu 24.04 | Rodar tudo | Suba para KVM 2 ao ter clientes pagantes (INSTRUCTIONS §7.1) |
| Conta no **GitHub** com o repositório | CI e imagens (GHCR) | Crie o *environment* `production` (passo 6) |
| **Cloudflare R2**: 2 buckets privados (`duckchat-media`, `duckchat-backups`) + 2 tokens de API | Mídia e backups | Token da mídia: só o bucket de mídia; token do backup: só o de backups (Object Read & Write) |
| Chave da **Anthropic** (console.anthropic.com) com limite de gasto | IA dos agentes | Começa com `sk-ant-` |
| **SMTP real** (Amazon SES, Resend, Brevo, Mailgun…) com SPF/DKIM/DMARC no seu domínio | Convites e redefinição de senha | Em desenvolvimento o e-mail vai para o Mailpit; **em produção é recusado** |
| Um **gerenciador de senhas** | Guardar `.env`, chave age, chave de cifra | Não é opcional (veja a lista abaixo) |
| Um serviço de **heartbeat** (healthchecks.io ou Better Stack) | Avisar se o backup parar | Gratuito; recomendado |

**Guarde no gerenciador de senhas, FORA do servidor:** (1) uma cópia do `.env` de produção; (2) a chave privada do backup (age); (3) principalmente a **`ENCRYPTION_KEY`** — sem ela os segredos cifrados dentro do banco (credenciais de canais, TOTP dos admins) ficam ilegíveis, até num backup restaurado.

### Gerar as chaves (no seu computador)

```bash
openssl rand -hex 24      # 6 vezes: POSTGRES_PASSWORD, APP_DB_PASSWORD, ADMIN_DB_PASSWORD, EVOLUTION_DB_PASSWORD, VALKEY_PASSWORD, EVOLUTION_API_KEY (uma diferente para cada)
openssl rand -hex 32      # BETTER_AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
age-keygen -o chave-backup.txt   # (instale o "age"); a linha "Public key: age1…" vai no .env; o ARQUIVO (chave privada) vai para o gerenciador de senhas e um pen drive
```

Nunca reaproveite os segredos de desenvolvimento.

## 2. Endurecer a VPS (antes do primeiro deploy) — INSTRUCTIONS §7.3

Faça pelo painel da Hostinger a criação da VPS e anote o IP. Entre como root **uma única vez** (`ssh root@IP`) e rode:

```bash
# 1) usuário de trabalho (não-root, com sudo) e usuário de deploy (para o GitHub)
adduser --disabled-password --gecos "" voce        # troque "voce" pelo seu nome
usermod -aG sudo voce
adduser --disabled-password --gecos "" deploy
mkdir -p /home/voce/.ssh /home/deploy/.ssh
# cole a chave PÚBLICA do seu computador (cat ~/.ssh/id_ed25519.pub) em:
nano /home/voce/.ssh/authorized_keys
# e a chave pública DEDICADA ao deploy (gerada no passo 6) em:
nano /home/deploy/.ssh/authorized_keys
chown -R voce:voce /home/voce/.ssh && chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/*/.ssh && chmod 600 /home/*/.ssh/authorized_keys
```

```bash
# 2) SSH só por chave, sem root
cat > /etc/ssh/sshd_config.d/99-duckchat.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
AllowUsers voce deploy
EOF
sshd -t && systemctl reload ssh
```

**Antes de fechar essa sessão**, abra OUTRA janela e confirme que `ssh voce@IP` funciona. Só então saia do root.

```bash
# 3) atualizações automáticas de segurança, fail2ban, firewall, swap (como voce: sudo …)
sudo apt update && sudo apt -y upgrade
sudo apt -y install unattended-upgrades fail2ban ufw curl
sudo dpkg-reconfigure -plow unattended-upgrades          # responda "Sim"
sudo systemctl enable --now fail2ban

sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp          # SSH (ideal: restrinja ao seu IP: sudo ufw allow from SEU.IP to any port 22)
sudo ufw enable

sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf && sudo sysctl --system
```

### Cuidado: o Docker "fura" o UFW

Portas **publicadas pelo Docker** (80 e 443 do Caddy) **não passam pelo UFW**. Por isso o firewall que vale para 80/443 é o **firewall do painel da Hostinger** (fora da máquina):

- Entrada permitida: **22** (de preferência só do seu IP), **80** e **443** **apenas dos IPs da Cloudflare**; todo o resto negado.
- Os IPs atuais: <https://www.cloudflare.com/ips/> (ou `deploy/cloudflare-ips.sh list`, que baixa a lista oficial).
- Como segunda camada, o Caddy tem `ORIGIN_LOCK=cloudflare` (padrão): ele corta a conexão de qualquer IP que não seja da Cloudflare. Os dois juntos protegem o IP "real" da VPS.

### Docker

```bash
# como voce:
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy        # o deploy precisa falar com o Docker
sudo mkdir -p /opt/duckchat && sudo chown deploy:deploy /opt/duckchat
```

> `deploy` no grupo `docker` equivale a poder virar root na máquina. Por isso: chave exclusiva, só o GitHub a possui, e a porta 22 restrita quando der. Os IPs do GitHub Actions mudam, então não dá para fixar um IP só; a chave dedicada e o `StrictHostKeyChecking` são a proteção.

## 3. Cloudflare

1. **DNS**: crie dois registros `A` (e `AAAA` se tiver IPv6) — `app` e `admin` — apontando para o IP da VPS, com a **nuvem laranja (Proxy) ligada**.
2. **SSL/TLS → Visão geral**: modo **Full (strict)**.
3. **Certificado de origem** (recomendado): SSL/TLS → *Servidor de origem* → *Criar certificado*: RSA, 15 anos, hostnames `app.seudominio.com.br` e `admin.seudominio.com.br` (ou `*.seudominio.com.br`). Salve o certificado em `origin.pem` e a chave privada em `origin.key`. Na VPS (passo 5) eles vão para `/opt/duckchat/deploy/certs/` com `chmod 600`. No `.env`: `TLS_MODE=origin`.
   - Alternativa `TLS_MODE=auto`: o Caddy emite o certificado sozinho (Let's Encrypt). Exige a porta 80 alcançável (pela Cloudflare) na emissão. Se falhar na 1ª vez, deixe os registros em "Só DNS" (nuvem cinza) por alguns minutos, e volte para o proxy.
4. **SSL/TLS → Certificados de borda**: *Always Use HTTPS* ligado; *TLS mínimo* 1.2; *HSTS* pode ficar desligado aqui (o app já envia).
5. **Velocidade → Otimização**: desligue **Rocket Loader**, **Auto Minify** e **Cloudflare Web Analytics/Browser Insights automático**. Eles injetam scripts e **quebram a CSP** do app (`script-src` com nonce, sem `unsafe-inline`).
6. **Rede**: *WebSockets* ligado (padrão).
7. **Segurança → WAF → Regras de limite de taxa** (o Caddy não tem rate limit próprio; a API tem limites por conta, mas a borda ajuda contra força bruta e DDoS):
   - `POST /api/v1/auth/*` → máx. ~20 por minuto por IP, ação *Bloquear* por 10 min;
   - `admin.seudominio.com.br/*` → máx. ~60 por minuto por IP.
8. **Painel admin, proteção extra (recomendado)**: *Zero Trust → Access* com uma aplicação em `admin.seudominio.com.br` permitindo só o seu e-mail. Além disso, preencha `ADMIN_IP_ALLOWLIST` no `.env` com os seus IPs.
9. **Armadilha dos 100 segundos (importante)**: a Cloudflare corta, nos planos Free/Pro/Business, qualquer requisição que demore mais de **100 s** para começar a responder (erro **524**). Gerar o perfil de um agente normalmente leva 20–25 s mas **pode passar de 2 minutos**. O Caddy aguarda até 330 s, mas nessa rota a Cloudflare pode cortar antes. Opções: (a) aceitar o risco (raro) e orientar o usuário a tentar de novo; (b) plano Enterprise (timeout configurável); (c) pedir ao time de desenvolvimento que a geração vire uma tarefa assíncrona (o front consulta o resultado) — é a correção certa e exige mudança de código, **ainda não feita**.

## 4. Bucket R2 da mídia (CORS)

O navegador envia (PUT) e lê (GET) os arquivos **direto** no R2, por URL assinada gerada pela API. Isso não passa pelo Caddy. Para funcionar:

1. No R2, abra o bucket de mídia → *Configurações* → *Política CORS* e cole (troque o domínio):

```json
[
  {
    "AllowedOrigins": ["https://app.seudominio.com.br"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

2. No `.env` (seção 7): `MEDIA_STORAGE_ENDPOINT`, `MEDIA_STORAGE_BUCKET`, chaves, `MEDIA_STORAGE_FORCE_PATH_STYLE=true`. O compose repassa a origem do R2 para o serviço **web** (`MEDIA_STORAGE_PUBLIC_ENDPOINT`, ou o próprio endpoint se vazio) e a **CSP** do app passa a liberar essa origem em `connect-src`, `img-src` e `media-src`. Sem isso o envio falha com "Não foi possível enviar o arquivo".
3. A origem liberada na CSP precisa ser **exatamente a das URLs assinadas**. Com `FORCE_PATH_STYLE=true` o endereço é `https://<conta>.r2.cloudflarestorage.com/<bucket>/…`, ou seja, a origem do endpoint. Se um dia usar endereço estilo `<bucket>.<conta>.r2…`, preencha `MEDIA_STORAGE_PUBLIC_ENDPOINT` com essa origem. **Confira no navegador** (F12 → Console/Rede) ao enviar o primeiro arquivo: erro de CSP ou de CORS aparece ali. Não foi testado com o R2 real.
4. Mantenha o bucket **privado** (sem acesso público nem domínio público); o acesso é só por URL assinada que expira.

## 5. Preparar a pasta na VPS

Como `deploy` (ou como `voce` com `sudo -u deploy`):

```bash
ssh deploy@IP
mkdir -p /opt/duckchat/deploy/certs
```

Para o **primeiro** deploy, os arquivos de `deploy/` chegam pelo próprio GitHub Actions (passo 7). Mas o `.env` e os certificados você coloca à mão, **uma vez**:

```bash
# do SEU computador (na raiz do repositório):
scp deploy/.env.production.example deploy@IP:/opt/duckchat/deploy/.env
scp origin.pem origin.key deploy@IP:/opt/duckchat/deploy/certs/
# na VPS:
ssh deploy@IP
cd /opt/duckchat/deploy
nano .env                     # preencha TUDO (veja os comentários); apague as linhas TROQUE…
chmod 600 .env certs/origin.key
```

> O deploy automático **substitui** os arquivos de `deploy/` a cada vez (compose, Caddyfile, scripts), mas **nunca** toca em `.env`, `certs/` nem `.deploy/`.

Conferência (a VPS recusa subir com erro):

```bash
cd /opt/duckchat/deploy && ./check-env.sh
```

Ele mostra só os **nomes** das variáveis com problema, nunca os valores. Corrija até aparecer `OK`.

## 6. Configurar o GitHub (uma vez)

1. **Chave SSH dedicada ao deploy** (no seu computador): `ssh-keygen -t ed25519 -f deploy_key -N ""`. A pública (`deploy_key.pub`) vai para `/home/deploy/.ssh/authorized_keys` na VPS (passo 2). A privada vai para o GitHub (abaixo) e **depois apague do seu computador**.
2. **Impressão digital do servidor** (para o GitHub não confiar às cegas): do seu computador, `ssh-keyscan -t ed25519 IP_DA_VPS` e **confira** a impressão digital com o painel da Hostinger/`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` na VPS. Copie a linha.
3. **Settings → Environments → New environment → `production`**: marque **Required reviewers** e coloque você. É isso que exige a **aprovação manual**: o job de deploy fica parado até você clicar em *Approve*.
4. No environment `production`, **Secrets**:

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP ou nome da VPS |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | conteúdo da chave **privada** `deploy_key` |
| `VPS_SSH_KNOWN_HOSTS` | a linha do `ssh-keyscan` conferida |
| `VPS_SSH_PORT` | (opcional) só se não for 22 |

   **Variables**: `APP_DOMAIN` = `app.seudominio.com.br`; `NEXT_PUBLIC_REALTIME_URL` = vazio (só preencha se o realtime ficar em outro host).
5. **Settings → Actions → General**: *Workflow permissions* = *Read repository contents*; o `deploy.yml` já pede `packages: write` só no job que publica.
6. Os pacotes do GHCR são privados por padrão; o `deploy.yml` faz o login temporário na VPS com o token do próprio job (não guarda senha nenhuma).

## 7. Primeiro deploy

1. No GitHub: **Actions → Deploy → Run workflow** (ou crie uma tag `v0.1.0`).
2. Ele roda a CI (typecheck e testes), constrói as 5 imagens e publica no GHCR com a tag do **commit**. Demora; a primeira vez não tem cache.
3. O job **deploy** fica em *Waiting*: abra, confira o commit e clique em **Approve and deploy**.
4. O que acontece na VPS (`deploy.sh up <commit>`): confere o `.env`, baixa as imagens, sobe Postgres/Valkey, roda `migrate` (cria os papéis do banco, aplica as migrations, ajusta permissões), sobe API, web, admin, realtime, Evolution, backup e Caddy, e espera todos ficarem saudáveis. Depois o GitHub confere `https://app…/entrar` pelo lado de fora.
5. Na VPS, confirme: `cd /opt/duckchat/deploy && ./deploy.sh status` — tudo `healthy` (o `migrate` aparece como `exited (0)`: é o certo).
6. Abra `https://app.seudominio.com.br`. Se a página abrir com cadeado, o HTTPS está certo.

**Se o primeiro deploy falhar**: veja a seção "Problemas comuns" e `./deploy.sh logs api`. Nada foi exposto de errado: as portas internas nunca são publicadas.

> Primeira criação do banco: as senhas `POSTGRES_PASSWORD` e `EVOLUTION_DB_PASSWORD` só são lidas **na primeira vez** que o volume do Postgres é criado. Trocá-las depois no `.env` não muda o banco. Para trocar: `ALTER ROLE … PASSWORD …` no Postgres e depois o `.env`. As senhas `APP_DB_PASSWORD` e `ADMIN_DB_PASSWORD`, ao contrário, são reaplicadas a cada deploy pelo `migrate`.

## 8. Criar o primeiro admin do painel

Siga [primeiro-admin.md](primeiro-admin.md) — mas atenção a um ponto de produção: **a VPS não tem o repositório nem `pnpm`**, e os scripts `seed-admin`/`admin-activation-code` são TypeScript. O caminho previsto é rodá-los **do seu computador** (com o repositório clonado e `pnpm install`) apontando para o Postgres da VPS por um **túnel SSH** (o banco nunca é exposto):

```bash
# 1) na VPS, descubra o IP interno do Postgres:
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' duckchat-postgres-1
# 2) no SEU computador, abra o túnel (deixe esta janela aberta):
ssh -N -L 55432:<IP_DO_POSTGRES>:5432 voce@IP_DA_VPS
# 3) em outra janela, com DATABASE_ADMIN_URL=postgres://duckzap:<POSTGRES_PASSWORD>@127.0.0.1:55432/duckzap
#    siga os passos 2 e 3 do primeiro-admin.md (ajuste a lista de e-mails do seed-admin antes; ele recusa NODE_ENV=production)
#    e use ENCRYPTION_KEY de produção só nessa janela (nunca num arquivo).
```

Ao terminar, feche o túnel (Ctrl+C), apague o histórico do terminal e `unset` das variáveis. **Este caminho não foi testado em servidor real** (o IP do contêiner pode ser inacessível do host dependendo da configuração de rede do Docker; se for o caso, peça ao desenvolvimento um comando de produção empacotado na imagem). Registre isso como pendência: o ideal é um comando `docker compose run` que dispense o repositório.

## 9. Conectar o WhatsApp por QR (Evolution) em produção

A Evolution API roda no compose, sem porta pública; só a API do DuckChat fala com ela (rede interna), e ela chama de volta o webhook da API também pela rede interna (`http://api:4000`).

1. Entre no app (`https://app…`) com a conta da empresa → **Canais → Novo canal → QR Code**.
2. Escaneie o QR no WhatsApp do celular (*Aparelhos conectados → Conectar um aparelho*).
3. Mande uma mensagem de outro número para o WhatsApp conectado e confira que ela aparece em **Conversas** (isso prova o ciclo Evolution → webhook interno → API → realtime).
4. Ver o painel da Evolution (`/manager`) é raramente necessário. Se precisar, use um túnel como o do passo 8 para `evolution:8080` e a chave `EVOLUTION_API_KEY`. Nunca publique essa porta.
5. Cada instância ocupa ~50 MB de RAM; na KVM 1 o limite prático é ~10 canais (INSTRUCTIONS §7.1.1).
6. **Cuidado**: nunca restaure um backup com a Evolution ligada em outro servidor enquanto a produção usa o mesmo número (veja restore.md).

## 10. Operação do dia a dia

### Atualizar para uma versão nova

Mesmo caminho do primeiro deploy: **Actions → Deploy → Run workflow** → aprovar. O deploy troca os contêineres, rodando antes as migrations. Fora do horário de pico: os contêineres reiniciam e há alguns segundos de indisponibilidade (não há *blue/green* na KVM 1).

### Voltar a versão (rollback)

Na VPS:

```bash
cd /opt/duckchat/deploy
./deploy.sh status        # mostra a versão atual e a anterior
./deploy.sh rollback      # volta para a anterior (ou, se o último deploy falhou, para a última boa)
```

Ou, para qualquer commit antigo cujas imagens ainda existam no GHCR: `./deploy.sh up <sha-do-commit>`.

**Limite honesto**: as migrations do banco **só andam para frente**. O rollback devolve o código antigo, mas o banco continua no esquema novo. Isso funciona quando a migration foi só "acrescentar" (coluna/tabela nova). Se uma migration apagou ou mudou algo, o código antigo pode quebrar: nesse caso restaure o backup ([restore.md](restore.md)). Por isso, evite deploy de sexta à noite.

### Ver logs

```bash
cd /opt/duckchat/deploy
./deploy.sh logs api            # segue os logs da API (Ctrl+C sai)
./deploy.sh logs web 200
docker compose -f docker-compose.prod.yml logs --since 1h caddy evolution   # (exporte IMAGE_TAG=$(cat .deploy/current-tag) antes)
```

Os logs têm rotação (5 arquivos de 10 MB por contêiner): o disco não enche por causa deles. Veja disco e memória: `df -h /` e `docker stats --no-stream`.

### Backup

O serviço `backup` roda todo dia às 03:30 (horário de Brasília). Confirme na primeira noite: `./deploy.sh logs backup` deve mostrar "concluído", e o bucket de backups deve ter a pasta do dia. Se configurou `BACKUP_HEARTBEAT_URL`, o serviço de heartbeat avisa quando o backup falha ou deixa de rodar. **Teste de restore todo mês**: [restore.md](restore.md). Backup que não foi restaurado não conta.

### Monitoramento (recomendado antes dos clientes)

Um monitor externo (Better Stack, UptimeRobot ou Uptime Kuma **em outro lugar**) em `https://app…/entrar`, mais alertas de disco, memória e backup. Gatilhos para subir de plano (INSTRUCTIONS §7.1.1): memória > 80% sustentada, swap em uso constante, fila de mensagens atrasando, ou primeiro cliente pagante.

## 11. Lista de conferência de segurança antes de abrir para clientes

Marque tudo. Item não marcado = não abra.

**Segredos**
- [ ] `./check-env.sh` dá `OK` e **nenhuma** chave de desenvolvimento foi reaproveitada (`ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, senhas, chave do Gemini/Anthropic de testes, `EVOLUTION_API_KEY`).
- [ ] O `.env` tem `chmod 600`; uma cópia está no gerenciador de senhas; **`ENCRYPTION_KEY` guardada fora do servidor**.
- [ ] A chave privada age do backup **não está** na VPS.
- [ ] Nenhum segredo no GitHub além dos listados; chave SSH de deploy apagada do seu computador.

**HTTPS, cookies, origens**
- [ ] Cloudflare em **Full (strict)**; `https://app…` e `https://admin…` com cadeado válido; `http://` redireciona.
- [ ] Os cookies de sessão aparecem com prefixo **`__Secure-`** (F12 → Aplicativo → Cookies: `__Secure-dz.session_token`), `Secure`, `HttpOnly`. Se vier sem o prefixo, algo está servindo por `http`.
- [ ] `PUBLIC_API_URL`, `WEB_URL`, `WEB_ORIGINS`, `ADMIN_ORIGINS` são `https://` e iguais aos domínios reais (o compose os monta a partir de `APP_DOMAIN`/`ADMIN_DOMAIN`; o código usa `PUBLIC_API_URL` — **não existe** `BETTER_AUTH_URL`). Login funciona e o `/ws` conecta (F12 → Rede → WS: status 101).
- [ ] **CSP** ativa: resposta de `https://app…/entrar` traz `Content-Security-Policy` com `script-src … 'nonce-…' 'strict-dynamic'` e **sem** `unsafe-inline`/`unsafe-eval`; o Console do navegador não mostra violações; Rocket Loader/Browser Insights da Cloudflare desligados.
- [ ] HSTS presente (`Strict-Transport-Security`).

**Acesso e abuso**
- [ ] `REQUIRE_2FA_FOR_ADMINS=true` e `ADMIN_REQUIRE_ACTIVATION_CODE=true`; o primeiro admin criado com senha forte (16+ caracteres) e **2FA cadastrado**; o código de ativação foi entregue por outro canal.
- [ ] Painel admin atrás de **Cloudflare Access** e/ou `ADMIN_IP_ALLOWLIST` preenchido.
- [ ] **Rate limits**: regras da Cloudflare para `/api/v1/auth/*` e para o admin (passo 3.7); os limites da própria API (`AGENTS_*_PER_MINUTE`, `CONVERSATIONS_*`, `CHANNELS_*`) conferidos com o plano de gasto da IA.
- [ ] Limite de gasto configurado no console da Anthropic.

**Rede**
- [ ] No firewall da Hostinger: 22 (idealmente só seu IP), 80 e 443 **só Cloudflare**, resto negado.
- [ ] `ss -tlnp` na VPS mostra só 22, 80 e 443 escutando para fora. Postgres (5432), Valkey (6379), Evolution (8080), API (4000), web (3000), admin (3002), realtime (4001) **não** aparecem.
- [ ] `https://app…/api/v1/health` responde 404 (a API só é pública nas rotas de login/webhook); `https://app…/openapi.json` não mostra a API sem login.
- [ ] SSH: só chave, sem root, fail2ban ativo (`sudo fail2ban-client status sshd`), atualizações automáticas ligadas.

**Dados e recuperação**
- [ ] Primeiro backup apareceu no bucket **e um restore de teste foi feito** (restore.md).
- [ ] Bucket de mídia **privado**, CORS só com a origem do app, token do R2 com permissão só nesse bucket.
- [ ] E-mail de verdade funcionando: convite e "esqueci a senha" chegam (SPF/DKIM/DMARC configurados).
- [ ] Termos, privacidade e LGPD revisados pela pessoa responsável antes de receber dados de clientes (INSTRUCTIONS §5.5).

## 12. Problemas comuns

| Sintoma | Causa provável e o que fazer |
|---|---|
| `check-env.sh` recusa | Leia as linhas `ERRO`: cada uma cita a variável. Marcador `TROQUE…` sobrando é o mais comum. |
| `migrate` falha com `role "duckzap_app" does not exist` | Versão antiga do compose. O compose atual cria os papéis **antes** de migrar. Atualize `deploy/`. |
| API reinicia em loop | `./deploy.sh logs api`: a API **recusa subir** com configuração inválida e diz qual variável (ex.: `ENCRYPTION_KEY` inválida, mídia pela metade, `LLM_PROVIDER=fake`). |
| Caddy não sobe: `…origin.pem: no such file` | `TLS_MODE=origin` sem os arquivos em `deploy/certs/`. Coloque-os ou use `TLS_MODE=auto`. |
| Erro **525/526** da Cloudflare | Certificado de origem ausente/errado, ou modo Full (strict) com certificado que não cobre o domínio. |
| Erro **521** | Caddy fora do ar ou firewall bloqueando a Cloudflare. |
| Erro **524** ao gerar perfil de agente | Passou de 100 s na Cloudflare (passo 3.9). |
| Login funciona mas volta para o login | Cookie sem `__Secure-`/`Secure`: acesso por `http`, ou `WEB_URL`/`PUBLIC_API_URL` errados. |
| `/ws` dá 403 | `Origin` do navegador diferente de `https://APP_DOMAIN` (www, http, porta). |
| Envio de arquivo falha | CSP sem a origem do R2 (conferir `MEDIA_STORAGE_*` e `docker compose exec web env | grep MEDIA`) ou CORS do bucket. |
| Todo mundo tem "o mesmo IP" nos limites | `TRUST_PROXY` — já ligado no compose; se mexeu no Caddyfile, mantenha `header_up X-Forwarded-For {client_ip}`. |
| Disco enchendo | `docker system df`; `docker image prune -af` apaga imagens antigas (o `deploy.sh` já poda as sem uso). |

## 13. Pendências conhecidas (para o time de desenvolvimento)

1. Migrations 0002+ fazem `GRANT … TO duckzap_app` e falham em banco **vazio** se o papel não existir. O compose de produção contorna rodando `setup-roles` antes do `migrate`; o `pnpm db:setup` de desenvolvimento e o job `integration` do CI têm a ordem inversa (migrate → roles) e falham num Postgres novo.
2. Criar o primeiro admin em produção exige o repositório (passo 8). Falta um comando empacotado na imagem.
3. `/agentes/gerar-perfil` pode passar de 100 s: a Cloudflare corta (passo 3.9). A correção estrutural é tarefa assíncrona.
4. As campanhas rodam dentro da API (`CAMPAIGNS_SCHEDULER=inline`); não existe `apps/worker` ainda.
5. `experimental.serverActions.bodySizeLimit` é 2 MB no web, mas a importação de contatos envia planilhas de até 10 MB por Server Action: arquivos > 2 MB provavelmente falham na importação (não foi mexido aqui por estar fora do escopo).
