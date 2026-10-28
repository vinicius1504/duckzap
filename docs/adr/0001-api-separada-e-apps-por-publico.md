# ADR 0001 — API como serviço separado e um app de front por público

- Status: aceito
- Data: 2026-10-26

## Contexto

O INSTRUCTIONS.md (§2 e §3.1) previa a API pública e os webhooks dentro do `apps/web` (Next.js), com Server Actions para a UI interna. Queremos:

1. Back e front bem separados, para subir a API em outra VPS quando precisar escalar, sem mexer no front.
2. Um Painel Super Admin (assinaturas, empresas, planos) isolado do app das empresas.

## Decisão

- **`apps/api`** é o único back-end HTTP: Node + **Hono** + `@hono/zod-openapi`. Concentra autenticação (Better Auth), `/v1/*`, webhooks (WhatsApp, pagamento) e o OpenAPI gerado do Zod. Tem build e imagem Docker próprios.
- **`apps/web`** (empresas) e o futuro **`apps/admin`** (super admin) são só front. Não acessam banco nem têm regra de negócio. Chamam a API pelo cliente tipado `@duckzap/api-client` (`hono/client` com o tipo `AppType` da API, importado só como tipo).
- O front chama `/api/*` no próprio domínio. Em dev, um rewrite do Next encaminha para `API_INTERNAL_URL`; em produção, o Caddy faz o mesmo. Assim o cookie de sessão fica no mesmo domínio (`SameSite=Lax`, sem CORS) e trocar a API de VPS é só mudar o destino do proxy.
- Server Actions **não** são usadas para regra de negócio. Quando forem usadas, só repassam para a API.
- `apps/admin` usa o mesmo `@duckzap/ui` (shell, componentes, tokens) com outro menu, um subdomínio próprio e, na API, rotas `/admin/*` com papel de banco separado e auditado (§3.4, §5.1).
- Regras de negócio ficam em `packages/core`, que a API consome. Se um dia surgir outro processo (worker), ele importa o mesmo `core`.

## Consequências

- Mais um serviço para rodar em dev (`pnpm dev` sobe os dois via Turborepo).
- Perdemos a conveniência das Server Actions com acesso direto ao banco. Em troca, o contrato fica explícito e é o mesmo para web, admin, app mobile futuro e integrações de clientes.
- §2 (linha "API") e §3.1 do INSTRUCTIONS.md passam a ser lidos à luz deste ADR.
