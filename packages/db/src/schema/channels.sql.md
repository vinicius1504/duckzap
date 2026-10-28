# SQL manual do módulo Canais (para o orquestrador)

`drizzle-kit generate` só gera as tabelas de `channels.ts`. O módulo precisa de **duas funções SQL** que o Drizzle não modela.
Coloque este SQL **na mesma migration** das tabelas (ou numa migration custom logo depois: `drizzle-kit generate --custom`), rodando como **papel dono** do banco.

## Por que existem

O webhook de entrada (`POST /v1/webhooks/wa/{provider}/{token}`) é público: não tem sessão, então não há `app.org_id`.
Para descobrir a qual empresa/canal o token pertence, é preciso ler `channels` **sem** tenant — e o papel `duckzap_app` (sem BYPASSRLS) não enxerga nada sem `app.org_id`.

Escolha: **funções `SECURITY DEFINER` estreitas** (e não um segundo papel de conexão, nem relaxar a policy de `channels`).

- A busca é por **igualdade no hash sha256 do token** (256 bits aleatórios). Não dá para listar nem enumerar canais; o token nunca chega ao banco em claro.
- Devolve só `organization_id`, `channel_id` e `provider` (o mínimo para abrir `withOrg` e seguir sob RLS normal). Nenhuma credencial.
- A função roda como o dono das tabelas (que ignora RLS porque as tabelas **não** têm `FORCE ROW LEVEL SECURITY` — o teste `rls-coverage` já exige que o papel do app não seja dono). **Não** ative `FORCE RLS` em `channels`/`inbound_events`, ou estas funções deixam de funcionar.
- `search_path` fixado (evita sequestro por objetos em schema do atacante), `EXECUTE` revogado de `PUBLIC` e dado só a `duckzap_app`.
- Tudo depois da resolução (gravar o evento, ler credenciais, atualizar status) roda em `withOrg(db, organizationId, ...)`, sob RLS normal.

A segunda função (`dz_orgs_with_pending_inbound`) serve ao `reprocessPending()`, que é um job sem sessão: devolve só ids de empresas que têm eventos pendentes; o processamento de cada empresa também roda em `withOrg`.

## SQL

```sql
CREATE OR REPLACE FUNCTION public.dz_resolve_channel_by_token(p_token_hash text)
RETURNS TABLE (organization_id text, channel_id uuid, provider text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.organization_id, c.id, c.provider
  FROM public.channels c
  WHERE c.webhook_token_hash = p_token_hash
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.dz_resolve_channel_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dz_resolve_channel_by_token(text) TO duckzap_app;

CREATE OR REPLACE FUNCTION public.dz_orgs_with_pending_inbound(p_limit integer)
RETURNS TABLE (organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT e.organization_id
  FROM public.inbound_events e
  WHERE e.processed_at IS NULL
    AND e.attempts < 5
    AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= now())
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
$$;

REVOKE ALL ON FUNCTION public.dz_orgs_with_pending_inbound(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_pending_inbound(integer) TO duckzap_app;
```

Observações:

- O papel `duckzap_app` precisa existir antes do `GRANT` (rode `db:roles` antes, ou troque a ordem na migration). Se a migration rodar antes de o papel existir, aplique só os dois `GRANT` depois de `db:roles`.
- `setup-roles.ts` dá `GRANT ... ON ALL TABLES`; funções não entram nisso, por isso o `GRANT EXECUTE` explícito acima.
- Teste de integração que valida isto: `apps/api/src/modules/channels/channels.integration.test.ts` (resolve token válido/ inválido e confirma que `duckzap_app` não lê `channels` sem tenant).
