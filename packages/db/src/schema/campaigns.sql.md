# SQL do módulo Campanhas que o Drizzle não gera

Para o orquestrador juntar na migration única (depois das tabelas). Aplicado só no banco descartável de teste.

O worker de campanhas (futuro `apps/worker`) roda sem sessão de empresa e conecta como `duckzap_app` (sem BYPASSRLS):
precisa descobrir QUAIS empresas têm campanhas vencidas antes de abrir `withOrg`. Mesmo padrão de `dz_orgs_with_pending_inbound`.

```sql
CREATE OR REPLACE FUNCTION public.dz_orgs_with_due_campaigns(p_limit integer)
RETURNS TABLE (organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT c.organization_id
  FROM public.campaigns c
  WHERE c.status IN ('scheduled', 'sending')
    AND (c.next_send_at IS NULL OR c.next_send_at <= now())
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
$$;
REVOKE ALL ON FUNCTION public.dz_orgs_with_due_campaigns(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_due_campaigns(integer) TO duckzap_app;
```

Observações:
- Só devolve ids de empresa (nenhum dado de campanha vaza). Se a função não existir, `runCampaignTick` aceita `organizationIds`
  explícitos e o tick não quebra (loga e segue).
- Nenhuma outra instrução raw: RLS, CHECKs, índices e FKs (cascata a partir de `contacts` para LGPD) estão no schema Drizzle.
