# SQL do módulo Conversas / Início que o Drizzle não gera

Para o orquestrador juntar na migration única. Nada disto foi executado no banco de dev.

## 1. Nada obrigatório

As tabelas `conversations`, `messages`, `conversation_suggestions`, `quick_replies` e `tasks` são geradas por inteiro pelo
`drizzle-kit generate` (RLS, policies, índices únicos parciais, CHECKs e FKs com `ON DELETE CASCADE` a partir de `contacts`).

Dependências de extensão (já existentes no banco): `pg_trgm` para `messages_body_trgm_idx` (`gin_trgm_ops`, busca no texto das
mensagens). A extensão é criada em `0002_raw_sql.sql`/init do Docker; a migration de Conversas precisa rodar DEPOIS dela.

Ordem das FKs: `conversations` referencia `contacts`, `channels`, `teams` e `agents` (todas já existem em `schema/`).

## 2. Opcional (escala): descoberta de empresas com trabalho pendente

A varredura em processo (`CONVERSATIONS_SWEEP_INTERVAL_MS`) lista as empresas pela tabela `organization` (Better Auth, sem RLS) e
processa cada uma dentro de `withOrg`. Com muitas empresas, um worker pode usar uma função `SECURITY DEFINER` estreita, no mesmo
molde de `dz_orgs_with_pending_inbound` (Canais):

```sql
CREATE OR REPLACE FUNCTION public.dz_orgs_with_due_conversations(p_limit integer)
RETURNS TABLE (organization_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT c.organization_id
  FROM public.conversations c
  WHERE c.ai_due_at IS NOT NULL AND c.ai_due_at <= now()
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
$$;
REVOKE ALL ON FUNCTION public.dz_orgs_with_due_conversations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_due_conversations(integer) TO duckzap_app;
```
