# DuckChat (nome provisório)

Leia o [INSTRUCTIONS.md](INSTRUCTIONS.md) e os ADRs em [docs/adr](docs/adr) antes de mexer.

## Estrutura

```
apps/
  api/          back-end (Hono). Único lugar com regra, banco e webhooks. Deploy próprio.
  web/          front das empresas (Next.js). Só front: chama /api/*.
  admin/        super admin: assinaturas, empresas, planos, auditoria. Mesmo UI, outro menu; fala com a API só pelo servidor.
packages/
  brand/        nome e textos da marca (renomear = 1 arquivo)
  ui/           tokens de cor, componentes e AppShell (rail + tab bar) reutilizáveis
  contracts/    schemas Zod compartilhados entre front e API
  db/           schema Drizzle, migrations, papéis do banco e seed
  ai/           interface única de IA (LLMProvider), adaptadores e guardrails dos agentes
  api-client/   cliente tipado da API para os fronts
  config/       tsconfig compartilhado
```

## Rodando

Requer Node 24 (`.nvmrc`). O pnpm vem pelo corepack (`corepack pnpm …`, ou `pnpm` se estiver no PATH).

**Estado atual: front e back ligados.** Todos os módulos do web e do admin falam com a API (`/v1/*`) e gravam no Postgres com isolamento por empresa (RLS). Os únicos pedaços ainda de exemplo são os passos de WhatsApp e agente do cadastro (`/comecar`, ver [docs/backend-contract.md](docs/backend-contract.md)). Contrato das funções em [docs/backend-contract.md](docs/backend-contract.md); convenções em [docs/backend-conventions.md](docs/backend-conventions.md) e [docs/frontend-conventions.md](docs/frontend-conventions.md).

| App | Endereço | Observação |
|-----|----------|------------|
| Empresas (`apps/web`) | http://localhost:3000 | Next.js; chama `/api/*`, que o Next encaminha para a API |
| Super admin (`apps/admin`) | http://localhost:3002 | Next.js; chama a API só pelo servidor (nunca pelo navegador) |
| API (`apps/api`) | http://localhost:4000 | Hono + Better Auth + Drizzle. `GET /v1/health` |

Módulos ligados: Entrar/Cadastro, Início, Conversas, Clientes, Agenda, Agentes de IA, Canais, Equipe (e convites em `/convite/:id`), Campanhas, Ajustes (empresa, plano, integrações, conta), Ajuda e o Painel Super Admin.

### Primeira vez

```sh
pnpm install
cp .env.example .env                       # senhas dos serviços Docker (valores aleatórios)
docker compose -f docker-compose.local.yml up -d
cp apps/api/.env.example apps/api/.env     # preencha BETTER_AUTH_SECRET, ENCRYPTION_KEY, senhas do banco
cp packages/db/.env.example packages/db/.env   # DATABASE_ADMIN_URL, APP_DB_PASSWORD, ADMIN_DB_PASSWORD, ADMIN_SEED_PASSWORD
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @duckzap/db db:setup         # papéis do banco, migrations, papéis de novo (tabelas novas) + seed (contas de teste)
pnpm --filter @duckzap/db db:seed-admin    # (opcional) admins do painel; ver docs/runbooks/primeiro-admin.md
pnpm dev                                   # web :3000, admin :3002, API :4000
```

Todo dia: `docker compose -f docker-compose.local.yml up -d` e `pnpm dev`. Outros comandos: `pnpm typecheck`, `pnpm build`, `pnpm test` (ver abaixo).

A API **não sobe** com configuração inválida: `ENCRYPTION_KEY` ausente ou fora de 32 bytes em base64 (`openssl rand -base64 32`), `LLM_PROVIDER` desconhecido, `BETTER_AUTH_SECRET` curto, `DATABASE_URL` ausente. Em produção também recusa `LLM_PROVIDER=fake`. A mensagem diz qual variável corrigir.

### Contas de teste (criadas por `db:seed`, só desenvolvimento)

Definidas em [packages/db/scripts/seed.ts](packages/db/scripts/seed.ts). A senha de todas é a constante `TEST_PASSWORD` desse arquivo (o seed recusa rodar com `NODE_ENV=production`).

| Conta | E-mail | Empresa / papel |
|-------|--------|-----------------|
| Proprietária | `marina@casaalvorada.com.br` | Casa Alvorada (plano Pro, ativo) |
| Atendente | `rafael@casaalvorada.com.br` | Casa Alvorada |
| Proprietária, plano expirado | `contato@studiolume.com.br` | Studio Lume (envio pausado) |
| Admin do painel | `admin@duckchat.com.br`, `bruno@duckchat.com.br` | criados por `db:seed-admin` (senha em `ADMIN_SEED_PASSWORD`; 2FA no primeiro login) |

### Começar do zero (conectar o seu WhatsApp de verdade)

```sh
CONFIRM_WIPE=sim pnpm --filter @duckzap/db db:wipe-dev   # apaga empresas, pessoas, contatos, conversas, canais… (mantém planos e super admins)
```

Depois abra http://localhost:3000/comecar, crie a sua conta (vira Proprietário, com 14 dias de teste do plano Pro) e conecte o WhatsApp em **Canais → Novo canal → QR Code** (a Evolution já sobe no Docker). O comando só roda no banco `duckzap`, nunca com `NODE_ENV=production` e pede `CONFIRM_WIPE=sim`.

### Regras de plano e conta

- Três planos: **Básico**, **Pro** e **Empresarial** (limites e recursos na tabela `plans`; preços `[A DEFINIR]`). Instagram no Pro e no Empresarial; Copiloto e "IA própria" (`byo_ai`, a fazer) só no Empresarial.
- Vencimento: **1 dia de tolerância**; depois a conta é **suspensa**: bloqueio total (a API responde `account_suspended`), o WhatsApp é desconectado por um job e a tela mostra "faça o acerto de contas". Só o Proprietário vê Plano e cobrança.
- Dono e administrador precisam de 2FA (`REQUIRE_2FA_FOR_ADMINS`, ligado por padrão em produção; desligado em desenvolvimento).

### Testes

```sh
pnpm test            # db + api + ai, com Postgres de teste (banco DESCARTÁVEL)
pnpm test:unit       # só o que não precisa de banco (é o que a CI roda primeiro)
```

`pnpm test` roda [scripts/test-all.sh](scripts/test-all.sh): troca o nome do banco das URLs dos `.env` por `duckzap_scratch_all` (nunca usa `duckzap`), liga as flags `*_INTEGRATION`, força `LLM_PROVIDER=fake` e executa os três pacotes. Como criar o banco descartável e filtrar testes: [docs/testes.md](docs/testes.md).

- Documentação da API: `GET /openapi.json` (exige sessão; `OPENAPI_PUBLIC=true` libera em dev).
- O front encaminha `/api/*` para a API (`API_INTERNAL_URL`). Em produção, o Caddy faz o mesmo, e a API pode estar em outra VPS.
- Imagem Docker da API: [apps/api/Dockerfile](apps/api/Dockerfile) (`docker build -f apps/api/Dockerfile -t duckchat-api .`). CI: [.github/workflows/ci.yml](.github/workflows/ci.yml).

### Serviços locais (Docker)

```sh
cp .env.example .env   # preencha com valores aleatórios (openssl rand -hex 24)
docker compose -f docker-compose.local.yml up -d
```

| Serviço | Endereço | Para quê |
|---------|----------|----------|
| Postgres 17 + pgvector | `localhost:5433` (db `duckzap`) | banco do app |
| Valkey | `localhost:6380` | cache e filas (BullMQ) |
| Evolution API | http://localhost:8081 (painel em `/manager`) | WhatsApp por QR Code |
| Mailpit | http://localhost:8026 (SMTP `localhost:1026`) | ver e-mails enviados em dev |

As portas fogem do padrão (5432, 6379) para não conflitar com outros projetos. Tudo fica preso a `127.0.0.1`.
