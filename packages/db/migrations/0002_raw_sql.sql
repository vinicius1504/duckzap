-- SQL que o Drizzle não gera (consolidado dos *.sql.md dos módulos). Idempotente onde possível.

-- ── Agenda: conflito de horário no banco (btree_gist) ───────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "owner_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" <> 'canceled' AND NOT "allow_conflict");--> statement-breakpoint

-- ── Canais: resolução do canal pelo token do webhook (público, sem sessão) ──────────────────
-- Funções SECURITY DEFINER estreitas. NÃO ative FORCE ROW LEVEL SECURITY em channels/inbound_events.
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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.dz_resolve_channel_by_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.dz_resolve_channel_by_token(text) TO duckzap_app;--> statement-breakpoint

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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.dz_orgs_with_pending_inbound(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.dz_orgs_with_pending_inbound(integer) TO duckzap_app;--> statement-breakpoint

-- ── Admin: auditoria só aceita INSERT (vale até para o dono) ────────────────────────────────
UPDATE "subscriptions" SET "on_trial" = true WHERE "status" = 'trial' AND "on_trial" = false;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs é append-only' USING ERRCODE = '42501';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON "audit_logs";--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
