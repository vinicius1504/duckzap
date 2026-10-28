# Runbook — restaurar um backup (e testar o restore todo mês)

Um backup que nunca foi restaurado é uma esperança, não um backup. Este roteiro serve para dois casos: **desastre** (a VPS morreu) e **teste mensal** (INSTRUCTIONS §7.4) numa VPS temporária, sem tocar na produção.

## O que existe

O serviço `backup` do compose roda todo dia (padrão 03:30, fuso `America/Sao_Paulo`) e grava no bucket de backups do Cloudflare R2:

```
duckchat/AAAA-MM-DD/duckzap-<data>.dump.age       banco principal (pg_dump formato custom, cifrado)
duckchat/AAAA-MM-DD/evolution-<data>.dump.age     banco da Evolution (sessões do WhatsApp por QR)
duckchat/AAAA-MM-DD/globals-<data>.sql.age        papéis do Postgres (sem as senhas em uso: o deploy as refaz)
```

Tudo é cifrado com **age** usando a chave PÚBLICA que está no servidor. Só quem tem a chave **privada** (`AGE-SECRET-KEY-…`, guardada no gerenciador de senhas e num pen drive) abre. Backups com mais de 30 dias são apagados.

**O que o backup NÃO guarda** (guarde por fora, no gerenciador de senhas):

- o arquivo `.env` de produção, **principalmente `ENCRYPTION_KEY`**: sem ela, os segredos cifrados dentro do banco (credenciais de canais, TOTP dos admins) ficam ilegíveis mesmo com o banco restaurado;
- a chave privada age;
- o certificado de origem da Cloudflare (`deploy/certs/`; dá para gerar outro);
- as mídias do bucket R2 de arquivos (têm a própria durabilidade do R2; para proteção extra contra exclusão acidental, ative o versionamento/regra de bloqueio do bucket).

Antes de começar, tenha em mãos: a chave privada age, o `.env` de produção (ou ao menos `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` e as senhas), e as chaves de leitura do bucket de backups.

## 1. Preparar a VPS temporária

1. Crie uma VPS pequena (2 GB serve para testar) com Docker, e siga só os passos 1 a 3 de [deploy.md](deploy.md) (usuário, Docker). **Não** aponte o DNS de produção para ela nem coloque a chave do `LLM_API_KEY`/SMTP reais: é um teste (se for um desastre de verdade, aí sim use o `.env` real).
2. Copie a pasta `deploy/` e `docker/postgres/init/` do repositório para `/opt/duckchat/` (o mesmo `tar` do deploy).
3. Instale `age` e `rclone` no servidor (ou rode o restore de dentro da imagem de backup, abaixo).

O jeito mais simples é usar a própria imagem de backup como "caixa de ferramentas": ela já tem `age`, `rclone` e `pg_restore` 17.

```bash
docker run --rm -it --network host -e HOME=/tmp --user postgres --entrypoint sh ghcr.io/<seu-usuario>/duckchat-backup:<tag>
```

## 2. Baixar os arquivos do R2

Dentro dessa caixa (ou no servidor, se instalou o rclone):

```bash
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_ENDPOINT='https://<ID_DA_CONTA>.r2.cloudflarestorage.com'
export RCLONE_CONFIG_R2_ACCESS_KEY_ID='<chave de leitura>' RCLONE_CONFIG_R2_SECRET_ACCESS_KEY='<segredo>'

rclone lsf r2:<bucket-de-backup>/duckchat/                 # dias disponíveis
rclone lsf r2:<bucket-de-backup>/duckchat/2026-10-28/      # arquivos do dia
mkdir -p /tmp/restore && rclone copy r2:<bucket-de-backup>/duckchat/2026-10-28 /tmp/restore
```

Escolha o dia certo: em caso de desastre, o mais recente; para investigar um erro, o dia anterior ao problema.

## 3. Decifrar

Cole a chave privada num arquivo temporário (o mesmo cuidado de senha: apague depois).

```bash
umask 077
cat > /tmp/chave-age.txt        # cole a linha AGE-SECRET-KEY-… e pressione Ctrl+D
for f in /tmp/restore/*.age; do age -d -i /tmp/chave-age.txt -o "${f%.age}" "$f"; done
ls -l /tmp/restore              # devem existir .dump e .sql sem o .age
```

Se aparecer `no identity matched any of the file's recipients`, a chave privada não é a do par usado no servidor.

## 4. Subir um Postgres vazio e restaurar

No servidor temporário, com o `.env` preenchido (para teste, valores novos servem; num desastre real, use os de produção):

```bash
cd /opt/duckchat/deploy
IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml up -d postgres      # cria o volume vazio e roda o init (extensões, banco/usuário da Evolution)
docker compose -f docker-compose.prod.yml exec postgres pg_isready -U duckzap  # espere "accepting connections"
```

Restaure os papéis, depois os bancos. O dump é de **formato custom**; o `pg_restore` aceita `--clean --if-exists` para sobrescrever o que o init criou:

```bash
PG="docker compose -f docker-compose.prod.yml exec -T postgres"
# 1) papéis (ignora o aviso de que 'duckzap' e 'evolution' já existem)
$PG psql -U duckzap -d postgres < /tmp/restore/globals-*.sql
# 2) banco principal
$PG pg_restore -U duckzap -d duckzap --clean --if-exists --no-owner --no-privileges < /tmp/restore/duckzap-*.dump
# 3) banco da Evolution
$PG pg_restore -U duckzap -d evolution --clean --if-exists --no-owner --no-privileges < /tmp/restore/evolution-*.dump
```

Avisos sobre objetos "does not exist" no `--clean` são normais num banco recém-criado. **Erros reais** (por exemplo, `extension "vector" is not available`) significam que o Postgres não é a imagem `pgvector`: confira o compose.

Os papéis do app (`duckzap_app`, `duckzap_admin`) voltam sem as senhas certas e sem os `GRANT` das tabelas. Quem os corrige é o serviço `migrate`, no passo seguinte.

## 5. Subir o resto e conferir

```bash
IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml up -d --wait   # o migrate refaz papéis/permissões e não acha migration nova
docker compose -f docker-compose.prod.yml ps
```

Conferências (todas devem passar):

- [ ] `ps` mostra tudo `healthy` (o `migrate` aparece como `exited (0)`).
- [ ] Contagens batem com o que você espera do dia do backup:
      `$PG psql -U duckzap -d duckzap -c "select (select count(*) from organization) empresas, (select count(*) from \"user\") usuarios;"`
- [ ] A tabela de migrations está inteira: `select count(*) from drizzle.__drizzle_migrations;` (mesmo número do repositório em `packages/db/migrations`).
- [ ] Em teste: acesse o app pelo túnel/hosts local (veja [deploy.md](deploy.md) para o `--resolve`), entre com uma conta real e abra uma conversa antiga.
- [ ] Os canais de WhatsApp por QR: **atenção** — a sessão restaurada pode tentar conectar o MESMO número que a produção usa. Num teste, **pare a Evolution** (`docker compose stop evolution`) antes de subir tudo, ou use `docker compose up -d --wait --scale evolution=0`. Dois aparelhos "iguais" brigando derrubam a conexão da produção.

## 6. Anotar e limpar (teste mensal)

1. Anote no registro de operações: data, dia restaurado, quanto tempo levou, o que deu errado. O tempo total é o seu RTO real.
2. Apague a chave privada do servidor (`shred -u /tmp/chave-age.txt`) e destrua a VPS temporária.
3. Se algo falhou, **conserte o backup antes de qualquer outra coisa**: um backup que não restaura vale zero.

## Em caso de desastre real

1. Suba uma VPS nova e endureça (deploy.md, seções 2 e 3). Faça o restore acima **com o `.env` original** (mesmos `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, senhas).
2. Troque o DNS/Cloudflare para o IP novo e instale o certificado de origem.
3. Os canais de WhatsApp por QR voltam a conectar sozinhos se a sessão restaurada ainda for válida; senão, reconecte pelo QR em Canais.
4. O backup é de até 24 h atrás: mensagens recebidas depois dele não estão no banco (os clientes podem reenviar; a Meta reenvia webhooks do canal oficial por algum tempo). Isso é o RPO atual. Para zerar o risco, a evolução prevista no INSTRUCTIONS §7.4 é WAL contínuo (WAL-G/pgBackRest), ainda não implementada.

## Limites conhecidos

- O restore documentado aqui foi **ensaiado só em Docker local** (dump, cifra, envio simulado, decifra, `pg_restore` em banco vazio). Ainda **não** foi testado contra o R2 real nem numa VPS.
- Não há WAL contínuo: o ponto de recuperação é o último backup diário.
