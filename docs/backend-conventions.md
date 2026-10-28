# Convenções do back (`apps/api` + `packages/db`)

Leia junto com o [INSTRUCTIONS.md](../INSTRUCTIONS.md) (§3 arquitetura, §4 IA, §5 segurança), o [ADR 0001](adr/0001-api-separada-e-apps-por-publico.md) e o [backend-contract.md](backend-contract.md) (as funções que o front espera de cada módulo — **é o seu contrato**).

## Objetivo desta fase (histórico) e estado atual

> Estado atual: os módulos abaixo já estão ligados ao front. Este documento segue valendo como regra para módulo novo. Erros de validação saem em `422 { error: { code: "validation_error", message: "Campo \"x\": …", fields } }` via `lib/http-validation.ts`; ids em corpo/query que são UUID precisam de `z.guid()` na rota (id malformado nunca pode chegar ao SQL). Segredos: `lib/crypto.ts` (v2 com kid e AAD `context`, rotação por `ENCRYPTION_KEYS`).

Substituir, módulo a módulo, o mock do front por back real, **sem mudar o que a tela vê**: o contrato em `packages/contracts/src/<módulo>.ts` e as assinaturas de `apps/web/src/features/<módulo>/api.ts` são a referência. O módulo termina quando (1) a API serve tudo o que o `api.ts` do front usa, (2) o `api.ts` do front chama a API em vez do mock, (3) os testes passam.

## Estrutura de um módulo no back

```
packages/db/src/schema/<modulo>.ts          tabelas Drizzle do módulo (já existe um arquivo vazio para você)
apps/api/src/modules/<modulo>/
  routes.ts        exporta `<modulo>Routes(deps)` (OpenAPIHono) — já registrado em modules/index.ts
  service.ts       casos de uso (regra de negócio), sem Hono: recebe (tx, ctx, input) e devolve dados/erros tipados
  queries.ts       acesso a dados (Drizzle) quando o service ficar grande
  *.test.ts        testes (vitest) do service
packages/contracts/src/<modulo>.ts          schemas Zod (já existe; ajuste só o necessário e avise)
apps/web/src/features/<modulo>/api.ts       troca o corpo pelas chamadas à API (mantém assinaturas); apague o mock-data.ts quando nada mais o usar
```

Rotas finas: **autenticar → autorizar → validar (Zod) → chamar o service → serializar** (§3.2). Regra de negócio nunca na rota.

## Padrões obrigatórios

**Multi-tenancy (inegociável, §3.4).**
- Toda tabela de negócio: `organizationId: organizationId()` + `.enableRLS()` + `tenantPolicy("<tabela>", t.organizationId)` e índice em `organization_id` (veja `schema/platform.ts` → `subscriptions` e `schema/_tenant.ts`). Teste `packages/db/test/rls-coverage.test.ts` falha se esquecer.
- Todo acesso a dado de empresa roda dentro de `withOrg(db, session.organization.id, async (tx) => …)`. O `organizationId` vem **sempre** da sessão, nunca do corpo, query ou path da requisição.
- O app conecta como `duckzap_app` (sem BYPASSRLS). Nunca use o papel dono em código de request.
- Ids de linha: UUID v7 (`uuid` → `v7()`). Datas: `timestamp({ withTimezone: true })`. Dinheiro: inteiro em centavos. Nomes de coluna em snake_case via `casing`.
- Chaves entre módulos: referencie tabelas de **outro** módulo só se ela já existir em `schema/`; se ainda não existir, use uma coluna `text` sem FK com o comentário `// FK adicionada na integração` (a integração fecha as FKs numa migration depois).

**Autenticação e autorização.**
- `requireAuth(deps)` (middleware) coloca `c.get("authSession")`; `buildSession(deps.db, authSession)` (`modules/session/queries.ts`) devolve a sessão do produto (papel, plano, status da assinatura).
- Autorização por papel: `can(role, permission)` de `@duckzap/contracts/permissions` — **a mesma matriz do front**. Toda rota que altera ou lê dado restrito checa. Se faltar permissão na matriz, adicione ao arquivo (mudança pequena e documentada no relatório).
- Plano expirado (`isSendingPaused`): leitura liberada, **envio de mensagem/campanha bloqueado no servidor**.
- Limites de plano (canais, usuários, agentes) aplicados **no backend** (`plans`/`subscriptions` em `schema/platform.ts`), nunca só na UI (§1.2).
- Respostas 401 (sem sessão), 403 (sem permissão ou plano), 404 (não existe **ou é de outra empresa** — não revele existência), 409, 422 (validação). Formato de erro: `{ error: { code, message } }` com `message` em pt-BR.

**Validação e segurança (§5).**
- Zod em toda entrada (body, query, params). Nada de `any`, `as` para calar tipo, `// @ts-ignore`.
- Segredos de integração (tokens de canal, chaves de provedor, segredos de webhook): cifrados em repouso (use `apps/api/src/lib/crypto.ts`: `encryptSecret(orgId, texto)`, `decryptSecret`, `lastFour`, `hashApiKey`, `generateSecret("dz_live_")`; chave mestra em `ENCRYPTION_KEY`), nunca em log, nunca devolvidos à UI (só últimos 4). Chaves de API do cliente: guardar **hash**, mostrar o segredo uma única vez.
- Webhooks de entrada: verificar assinatura/segredo, idempotência por id externo, responder 200 rápido e processar depois.
- Webhooks de saída: assinados com HMAC, bloqueio de SSRF (IPs privados/metadata).
- Rate limit em endpoints sensíveis (login já tem no Better Auth; adicione onde fizer sentido).
- Logs sem dado sensível (nada de senha, token, CPF, corpo de mensagem em nível info).

**Eventos e filas (§3.2).** Escrita relevante grava um evento na tabela `outbox_events` na **mesma transação** (se a tabela ainda não existir, o módulo que precisar a cria em `schema/platform.ts` seguindo o padrão tenant). Processamento assíncrono (envio de mensagem, campanhas, follow-up, lembretes) via BullMQ no futuro `apps/worker`; nesta fase, onde o envio real exigir fila, implemente o **caso de uso e a interface** (porta `Queue`/`MessagingProvider`) com uma implementação em memória/log e deixe claro no relatório o que falta para ligar o Redis.

**Testes (§6.4, definição de pronto).** Para cada módulo: teste do caso de uso (Vitest) **e** teste de autorização (outro tenant não lê/escreve; papel sem permissão é barrado). Testes de integração usam o Postgres real do Docker (`DATABASE_URL`, papel `duckzap_app`); copie o estilo de `packages/db/test/tenant-isolation.test.ts`. Dados de teste com ids únicos e limpeza ao final.

## IA, mensagens e variáveis de ambiente

- **IA**: sempre pela interface `LLMProvider` de `@duckzap/ai` (`deps.llm`), nunca por um SDK direto. Modelos por nível (`fast`/`smart`), não por nome. Trocar Claude por ChatGPT/Gemini é um novo adaptador em `packages/ai/src/providers/` + `LLM_PROVIDER`; nada do produto muda. Em teste use `createFakeLlm`.
- **Mensagens**: provedores de WhatsApp/Instagram pela interface `MessagingProvider` de `apps/api/src/lib/messaging.ts`. Eventos recebidos passam por `lib/inbound.ts` (Canais despacha, Conversas registra o handler).
- **Variáveis de ambiente novas** (de um módulo): leia com um `config.ts` no próprio módulo (`z.object({...}).parse(process.env)`), não edite `src/env.ts`. Documente o nome em `apps/api/.env.example` (acrescente no fim). Não imprima valores de segredos.

## Banco e migrations — REGRA IMPORTANTE (vários agentes em paralelo)

- Você **escreve** o schema em `packages/db/src/schema/<seu-modulo>.ts`, mas **NÃO roda** `drizzle-kit generate`, `db:migrate`, `db:setup` nem edita `packages/db/migrations/`. Uma pessoa (o orquestrador) gera uma única migration juntando todos os módulos e aplica no banco. Você valida com `typecheck`.
- Por isso você ainda **não consegue rodar** teste de integração contra tabelas novas. Escreva os testes assim mesmo (eles serão executados na integração) e marque no relatório quais dependem de migration.
- Não edite arquivos de outro módulo, `packages/db/src/schema/index.ts`, `modules/index.ts`, `app.ts`, nem os `packages/ui`. Precisa de algo compartilhado? Crie dentro do seu módulo e liste no relatório.
- Não rode `pnpm add` (dependências já instaladas: hono, @hono/zod-openapi, zod, drizzle-orm, postgres, better-auth, uuid, nodemailer). Se realmente precisar de uma dependência nova, diga no relatório em vez de instalar.
- Não suba servidores (`pnpm dev`) nem rode `build`. Typecheck: `export PATH="$HOME/.local/bin:$PATH"; pnpm --filter @duckzap/api typecheck` (e `@duckzap/db`, `@duckzap/contracts`, `@duckzap/web` se mexer neles). Erros em arquivos de outro módulo não são seus.

## Ligar o front ao back (último passo de cada módulo)

Em `apps/web/src/features/<modulo>/api.ts`, troque o corpo de cada função para chamar a API com `apiFetch` de `@/lib/api-server` (repassa o cookie de sessão; veja `features/auth/api.ts`), validando a resposta com o schema Zod do contrato e mantendo as assinaturas e os tipos de retorno (`Result` etc.). Server Actions e telas **não mudam**. Remova o `mock-data.ts` quando nada mais o importar (alguns módulos ainda leem dados de outros módulos mockados: nesse caso deixe o mock mínimo e avise no relatório). Se uma função do front não tem rota ainda, deixe-a no mock e liste no relatório.
