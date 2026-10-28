# Convenções do front

Vale para `apps/web` (empresas) e `apps/admin` (super admin). Leia junto com o [INSTRUCTIONS.md](../INSTRUCTIONS.md) e o [ADR 0001](adr/0001-api-separada-e-apps-por-publico.md).

**Estado:** as telas estão ligadas ao back por módulo, e a regra continua valendo: tela só conhece `features/<módulo>/api.ts`. Trocar a origem do dado (mock ↔ API) é mudar o corpo dessas funções, sem mexer nas telas. Módulo novo: comece pelo contrato em `packages/contracts`, crie a rota em `apps/api/src/modules/<módulo>` e só então o `api.ts` (use `callApi`/`readApi` de `@/lib/api-call`).

## Referência visual

As telas desenhadas ficam em [docs/design/](design/), uma por módulo (`Conversas.dc.html`, `Clientes.dc.html`…). São HTML com CSS inline. Siga layout, textos, estados e hierarquia, mas **reescreva com os componentes e tokens do projeto**: nada de hex solto, nada de `style` copiado (exceto larguras ou alturas calculadas por dado). Ignore o `<script>` DCLogic no fim, que só alterna estados da maquete. Onde a maquete usa `[VALOR]` ou `[LINK]`, mantenha o placeholder no mock.

## Estrutura de um módulo

```
packages/contracts/src/<modulo>.ts        schemas Zod + tipos do domínio (nomes em inglês)
apps/web/src/features/<modulo>/
  api.ts            "server-only". ÚNICA porta de dados. Funções async (list…, get…, create…, update…).
                    Chama a API (`apiFetch`/`callApi`) e valida a resposta com o schema do contrato. Assinaturas estáveis.
  mock-data.ts      (só em módulo ainda não ligado) dados de exemplo tipados com o contrato. Só api.ts importa.
  actions.ts        "use server". Finas: requireSession() → validar com Zod → api.ts → revalidatePath.
  components/       componentes do módulo (client ou server).
apps/web/src/app/(app)/<rota>/page.tsx  Server Component fino: lê searchParams, chama api.ts, monta a tela.
```

O exemplo completo é o **Início**: [contracts/home.ts](../packages/contracts/src/home.ts), [features/home](../apps/web/src/features/home) e [app/(app)/inicio/page.tsx](../apps/web/src/app/(app)/inicio/page.tsx).

Regras:
- Tela nunca importa `mock-data.ts`. Componente client nunca importa `api.ts`: usa props vindas do server ou `actions.ts`.
- O dado não carrega nada visual (cor, rótulo de chip). O contrato tem `status: "pending" | "confirmed"`, e a tela mapeia isso para o tom e o texto.
- Datas no contrato são ISO em UTC (`z.iso.datetime()`); exiba com `lib/format.ts` no fuso da organização (`session.organization.timeZone`). Dinheiro em centavos (`formatMoney`).
- Mutações: Server Action + `revalidatePath`. Use `useOptimistic` ou `useTransition` para resposta imediata. Mutação que falha devolve `{ error: string }` e a UI mostra.
- `lib/mock.ts` hoje só hospeda o tipo `Result` e `ok`/`fail`; `mockDelay()`/`mockId()` são para o que ainda é exemplo (passos do cadastro). Não grave estado em memória no front para módulo ligado: o dado mora na API.
- Filtros, abas, busca e paginação ficam na URL (`nuqs` no client; `searchParams` validado com Zod no server). Ex.: `/conversas?aba=minhas&visao=quadro`.
- Sessão: `requireSession()` de `features/auth/session.ts` (traz `user.role`, `organization.plan` e `subscriptionStatus`). Plano expirado (`isSendingPaused(session)`): ações de **envio** ficam desabilitadas, com explicação.
- **Permissões por papel (§5.1):** a matriz única está em [contracts/permissions.ts](../packages/contracts/src/permissions.ts) (`can(role, "campaign.send")`). Páginas restritas usam `requirePermission("…")` de `features/auth/permissions.ts`. Toda Server Action que altera algo começa com `const auth = await authorize("…"); if ("error" in auth) return auth;`. Na UI, use `can(session.user.role, …)` para esconder ou desabilitar botões (com dica do motivo quando desabilitar). O menu já é filtrado em `config/nav.ts`. Teste com a atendente do seed (`rafael@casaalvorada.com.br`, ver README). Se faltar uma permissão na matriz, não edite o arquivo: use a mais próxima e cite no relatório.
- Limites de plano (§1.2) aparecem na UI vindos da API (ex.: "4 de 5 canais"); a verdade é do back, que também barra o excesso.

## UI

- Componentes: `@duckzap/ui/components/*`: `button` (`Button`, `buttonVariants` para links), `input` (`Input`, `Label`, `FieldError`), `form-controls` (`Textarea`, `Select`, `Checkbox`, `Radio`), `chip`, `card`, `segmented`, `tabs`, `dialog` (modal e `side="right"` para gaveta), `dropdown-menu`, `switch`, `table` (`Table`, `Th`, `Td`), `avatar`, `feedback` (`Alert`, `EmptyState`, `Progress`, `Skeleton`, `Spinner`), `layout` (`Page`, `PageHeader`, `Steps`), `icon` (veja a lista de nomes em `icon.tsx`), `logo`. `cn` em `@duckzap/ui/cn`.
- **Não edite `packages/ui`** nem arquivos de outro módulo. Precisa de algo que não existe? Crie dentro de `features/<seu-modulo>/components/` (ícone extra: SVG inline de traço, `aria-hidden`). Liste no seu relatório o que deveria virar componente compartilhado.
- Cores só por tokens Tailwind: `bg-surface`, `bg-bg`, `bg-surface-2`, `text-ink`, `text-ink-2`, `border-line`, `border-field`, `bg-duck`, `text-on-duck`, `bg-ok-bg text-ok`, `warn`, `err`, `info`, `bg-rail`. Raios: `rounded-control` (10px), `rounded-card` (14px), `rounded-full` (chips). Precisa funcionar em **tema claro e escuro**, então não use `bg-white` nem `text-black`.
- Prefira as classes canônicas do Tailwind (`max-w-100` em vez de `max-w-[400px]`) quando existirem.
- Acessível: `<button>` e `<a>` de verdade, `<label>` em todo campo, `aria-label` em botão só com ícone, alvo de toque ≥ 44px no celular, foco visível (já global), texto ≥ 4.5:1.
- Responsivo até 360px: nada de rolagem horizontal da página (tabelas rolam dentro do `Table`). Abaixo de `md` o rail some e aparece a tab bar; o conteúdo já tem `pb-20`.
- Textos de UI em pt-BR, simples e diretos ("Reconectar agora", não "Reestabelecer sessão"). Código e nomes de domínio em inglês.
- Estados obrigatórios em toda lista e tela: vazio (`EmptyState`), carregando (`loading.tsx` com `Skeleton` na rota), erro (`error.tsx` com "Tentar de novo") e limite de plano quando se aplicar.

## TypeScript

`strict` + `noUncheckedIndexedAccess`. Sem `any`, sem `as` para calar erro, sem `// @ts-ignore`. Rode o typecheck só do seu app:

```sh
export PATH="$HOME/.local/bin:$PATH"   # pnpm via corepack
pnpm --filter @duckzap/web typecheck   # ou @duckzap/admin
```

Erros em pastas de outro módulo (outro agente trabalhando em paralelo) não são seus; ignore e não toque. **Não rode `next build`, `pnpm dev` nem `pnpm add`** (dependências já instaladas: nuqs, date-fns, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities, react-hook-form, @hookform/resolvers, zod, radix-ui via `@duckzap/ui`).
