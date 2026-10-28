-- Job de suspensão de contas (apps/api/src/jobs.ts → modules/channels/suspension.ts).
-- Função SECURITY DEFINER estreita (mesmo padrão de dz_orgs_with_pending_inbound): devolve só o necessário para a API
-- decidir com `effectiveSubscriptionStatus` (a regra de tolerância fica em TypeScript, num lugar só).
-- NÃO ative FORCE ROW LEVEL SECURITY em subscriptions/channels, ou esta função deixa de funcionar.

CREATE OR REPLACE FUNCTION public.dz_orgs_with_live_channels_and_lapsed_subscription(p_limit integer)
RETURNS TABLE (organization_id text, status text, current_period_end timestamptz, disabled_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.organization_id, s.status, s.current_period_end, s.disabled_at
  FROM public.subscriptions s
  WHERE (s.status IN ('expired', 'canceled') OR s.disabled_at IS NOT NULL OR s.current_period_end < now())
    AND EXISTS (
      SELECT 1 FROM public.channels c
      WHERE c.organization_id = s.organization_id
        AND c.type IN ('whatsapp_qr', 'whatsapp_official')
        AND c.status <> 'disconnected'
    )
  LIMIT greatest(1, least(coalesce(p_limit, 50), 500))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.dz_orgs_with_live_channels_and_lapsed_subscription(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_live_channels_and_lapsed_subscription(integer) TO duckzap_app;
