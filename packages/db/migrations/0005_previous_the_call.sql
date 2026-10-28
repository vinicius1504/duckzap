-- Consolidação pós-revisão. Editada à mão a partir do que o drizzle-kit gerou: o gerador troca text→uuid sem USING (falha),
-- não copia dados antes de apagar colunas e não conhece os planos novos. Ordem: coluna nova → planos → saneamento →
-- tipos com USING → órfãos → cópia dos vínculos → DDL restante (FKs, índices, DROP das colunas antigas, CHECK).

-- ── 1) Orçamento de tokens por plano e planos novos (basico, pro, empresarial) ─────────────────────────────────────────
ALTER TABLE "plans" ADD COLUMN "monthly_token_limit" integer;--> statement-breakpoint
INSERT INTO "plans" ("slug", "name", "max_channels", "max_users", "max_agents", "features", "monthly_token_limit", "active") VALUES
  ('basico', 'Básico', 2, 2, 1, '{}', 1500000, true),
  ('empresarial', 'Empresarial', 15, 20, NULL, ARRAY['campaigns','instagram','copilot','byo_ai'], 30000000, true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name", "max_channels" = EXCLUDED."max_channels", "max_users" = EXCLUDED."max_users",
  "max_agents" = EXCLUDED."max_agents", "features" = EXCLUDED."features", "monthly_token_limit" = EXCLUDED."monthly_token_limit";--> statement-breakpoint
UPDATE "plans" SET "features" = ARRAY['campaigns','instagram'], "monthly_token_limit" = 8000000 WHERE "slug" = 'pro';--> statement-breakpoint
-- preços e checkout já definidos nos planos antigos passam para os novos
UPDATE "plans" n SET
  "first_month_price_cents" = o."first_month_price_cents",
  "recurring_price_cents" = o."recurring_price_cents",
  "checkout_url" = o."checkout_url"
FROM "plans" o
WHERE (n."slug", o."slug") IN (('basico', 'essencial'), ('empresarial', 'escala'));--> statement-breakpoint
UPDATE "subscriptions" SET "plan_slug" = 'basico' WHERE "plan_slug" = 'essencial';--> statement-breakpoint
UPDATE "subscriptions" SET "plan_slug" = 'empresarial' WHERE "plan_slug" = 'escala';--> statement-breakpoint
DELETE FROM "plans" WHERE "slug" IN ('essencial', 'escala');--> statement-breakpoint

-- ── 2) Saneamento antes das novas restrições ─────────────────────────────────────────────────────────────────────────
UPDATE "teams" SET "color" = 'slate' WHERE "color" NOT IN ('yellow','slate','green','blue','orange','red');--> statement-breakpoint
UPDATE "contacts" SET "owner_id" = NULL WHERE "owner_id" IS NOT NULL AND "owner_id" NOT IN (SELECT "id" FROM "user");--> statement-breakpoint
UPDATE "conversations" SET "assignee_id" = NULL WHERE "assignee_id" IS NOT NULL AND "assignee_id" NOT IN (SELECT "id" FROM "user");--> statement-breakpoint

-- ── 3) Colunas text → uuid (valor que não é uuid vira NULL) ──────────────────────────────────────────────────────────
ALTER TABLE "channels" ALTER COLUMN "team_id" SET DATA TYPE uuid USING (CASE WHEN "team_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "team_id"::uuid END);--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "agent_id" SET DATA TYPE uuid USING (CASE WHEN "agent_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "agent_id"::uuid END);--> statement-breakpoint
ALTER TABLE "consents" ALTER COLUMN "channel_id" SET DATA TYPE uuid USING (CASE WHEN "channel_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "channel_id"::uuid END);--> statement-breakpoint
ALTER TABLE "ai_usage_log" ALTER COLUMN "agent_id" SET DATA TYPE uuid USING (CASE WHEN "agent_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "agent_id"::uuid END);--> statement-breakpoint
ALTER TABLE "conversation_ai_events" ALTER COLUMN "agent_id" SET DATA TYPE uuid USING (CASE WHEN "agent_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "agent_id"::uuid END);--> statement-breakpoint
ALTER TABLE "copilot_feedback" ALTER COLUMN "agent_id" SET DATA TYPE uuid USING (CASE WHEN "agent_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "agent_id"::uuid END);--> statement-breakpoint
ALTER TABLE "copilot_feedback" ALTER COLUMN "message_id" SET DATA TYPE uuid USING (CASE WHEN "message_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "message_id"::uuid END);--> statement-breakpoint
ALTER TABLE "conversation_suggestions" ALTER COLUMN "agent_id" SET DATA TYPE uuid USING (CASE WHEN "agent_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "agent_id"::uuid END);--> statement-breakpoint

-- ── 4) Órfãos viram NULL antes de criar cada FK ──────────────────────────────────────────────────────────────────────
UPDATE "channels" SET "team_id" = NULL WHERE "team_id" IS NOT NULL AND "team_id" NOT IN (SELECT "id" FROM "teams");--> statement-breakpoint
UPDATE "channels" SET "agent_id" = NULL WHERE "agent_id" IS NOT NULL AND "agent_id" NOT IN (SELECT "id" FROM "agents");--> statement-breakpoint
UPDATE "consents" SET "channel_id" = NULL WHERE "channel_id" IS NOT NULL AND "channel_id" NOT IN (SELECT "id" FROM "channels");--> statement-breakpoint
UPDATE "ai_usage_log" SET "agent_id" = NULL WHERE "agent_id" IS NOT NULL AND "agent_id" NOT IN (SELECT "id" FROM "agents");--> statement-breakpoint
UPDATE "conversation_ai_events" SET "agent_id" = NULL WHERE "agent_id" IS NOT NULL AND "agent_id" NOT IN (SELECT "id" FROM "agents");--> statement-breakpoint
UPDATE "copilot_feedback" SET "agent_id" = NULL WHERE "agent_id" IS NOT NULL AND "agent_id" NOT IN (SELECT "id" FROM "agents");--> statement-breakpoint
UPDATE "copilot_feedback" SET "message_id" = NULL WHERE "message_id" IS NOT NULL AND "message_id" NOT IN (SELECT "id" FROM "messages");--> statement-breakpoint
UPDATE "conversation_suggestions" SET "agent_id" = NULL WHERE "agent_id" IS NOT NULL AND "agent_id" NOT IN (SELECT "id" FROM "agents");--> statement-breakpoint

-- ── 5) Fonte única do vínculo: copia de teams/agents para channels ANTES de apagar as colunas antigas ───────────────────
UPDATE "channels" c SET "team_id" = s."team_id"
FROM (
  SELECT DISTINCT ON (ch."id") ch."id" AS channel_id, t."id" AS team_id
  FROM "channels" ch
  JOIN "teams" t ON t."organization_id" = ch."organization_id" AND ch."id"::text = ANY(t."channel_ids")
  ORDER BY ch."id", t."priority", t."created_at"
) s
WHERE c."id" = s.channel_id AND c."team_id" IS NULL;--> statement-breakpoint
UPDATE "channels" c SET "agent_id" = s."agent_id"
FROM (
  SELECT DISTINCT ON (ch."id") ch."id" AS channel_id, a."id" AS agent_id
  FROM "channels" ch
  JOIN "agents" a ON a."organization_id" = ch."organization_id" AND ch."id"::text = ANY(a."channel_ids")
  ORDER BY ch."id", (a."status" = 'active') DESC, a."is_default" DESC, a."created_at"
) s
WHERE c."id" = s.channel_id AND c."agent_id" IS NULL;--> statement-breakpoint
UPDATE "channels" c SET "agent_id" = a."id"
FROM "teams" t JOIN "agents" a ON a."id"::text = t."agent_id"
WHERE c."team_id" = t."id" AND c."agent_id" IS NULL;--> statement-breakpoint

-- ── 6) Excluir canal preserva conversas e mensagens (channel_id nullable, SET NULL) ──────────────────────────────────────
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint

-- ── 7) Chaves estrangeiras, índices, colunas antigas e CHECK (gerado pelo drizzle-kit) ──────────────────────────────────
ALTER TABLE "channels" ADD CONSTRAINT "channels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ai_events" ADD CONSTRAINT "conversation_ai_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_suggestions" ADD CONSTRAINT "conversation_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_team_id_idx" ON "channels" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "channels_agent_id_idx" ON "channels" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "consents_contact_id_idx" ON "consents" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "appointments_contact_id_idx" ON "appointments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "appointments_type_id_idx" ON "appointments" USING btree ("type_id");--> statement-breakpoint
CREATE INDEX "conversations_contact_id_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_channel_id_idx" ON "conversations" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_open_per_contact_no_channel" ON "conversations" USING btree ("organization_id","contact_id") WHERE "conversations"."status" <> 'resolved' and "conversations"."channel_id" is null;--> statement-breakpoint
CREATE INDEX "tasks_contact_id_idx" ON "tasks" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "channel_ids";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "agent_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "channel_ids";--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_color_check" CHECK ("teams"."color" in ('yellow','slate','green','blue','orange','red'));
