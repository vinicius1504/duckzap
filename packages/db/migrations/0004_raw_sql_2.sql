-- SQL que o Drizzle não gera (Campanhas e Conversas). Funções SECURITY DEFINER estreitas: devolvem só ids de empresa,
-- para jobs sem sessão descobrirem onde há trabalho antes de abrir `withOrg`. Mesmo padrão de dz_orgs_with_pending_inbound.
-- NÃO ative FORCE ROW LEVEL SECURITY em campaigns/conversations, ou estas funções deixam de funcionar.

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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.dz_orgs_with_due_campaigns(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_due_campaigns(integer) TO duckzap_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.dz_orgs_with_due_conversations(p_limit integer)
RETURNS TABLE (organization_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT c.organization_id
  FROM public.conversations c
  WHERE c.ai_due_at IS NOT NULL AND c.ai_due_at <= now()
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.dz_orgs_with_due_conversations(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_due_conversations(integer) TO duckzap_app;
