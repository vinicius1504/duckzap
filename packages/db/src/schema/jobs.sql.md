# SQL dos jobs de fundo que o Drizzle não gera

Para o orquestrador juntar na migration única. Mesmo padrão de `dz_orgs_with_pending_inbound`: função SECURITY DEFINER estreita para jobs sem sessão de empresa.

## Suspensão de contas (`apps/api/src/jobs.ts` → `modules/channels/suspension.ts`)

Empresas que ainda têm canal WhatsApp NÃO desconectado e cuja assinatura PODE estar suspensa (vencida, expirada, cancelada ou desativada).
Devolve só o necessário para a API decidir com `effectiveSubscriptionStatus` (a regra de tolerância fica em TypeScript, num lugar só).

```sql
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
$$;
REVOKE ALL ON FUNCTION public.dz_orgs_with_live_channels_and_lapsed_subscription(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_live_channels_and_lapsed_subscription(integer) TO duckzap_app;
```

Sem coluna de "motivo" no canal: o motivo `suspended` vai para o log estruturado (`channels.suspended`), sem dado pessoal.
