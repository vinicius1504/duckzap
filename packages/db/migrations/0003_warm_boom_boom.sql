CREATE TABLE "conversation_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_id" text,
	"body" text NOT NULL,
	"rating" text,
	"rated_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_suggestions_rating_check" CHECK ("conversation_suggestions"."rating" is null or "conversation_suggestions"."rating" in ('useful','bad'))
);
--> statement-breakpoint
ALTER TABLE "conversation_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"team_id" uuid,
	"assignee_id" text,
	"agent_id" uuid,
	"status" text DEFAULT 'human_active' NOT NULL,
	"mode" text DEFAULT 'human' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"waiting_since" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_preview" text DEFAULT '' NOT NULL,
	"last_message_kind" text DEFAULT 'text' NOT NULL,
	"last_message_file_name" text,
	"last_message_duration_seconds" integer,
	"last_message_direction" text DEFAULT 'in' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_reply_at" timestamp with time zone,
	"first_response_seconds" integer,
	"follow_up_at" timestamp with time zone,
	"follow_up_paused" boolean DEFAULT false NOT NULL,
	"ai_due_at" timestamp with time zone,
	"ai_burst_started_at" timestamp with time zone,
	"out_of_hours_notice_at" timestamp with time zone,
	"window_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('ai_active','handoff_requested','human_active','resolved')),
	CONSTRAINT "conversations_mode_check" CHECK ("conversations"."mode" in ('ai','copilot','human')),
	CONSTRAINT "conversations_priority_check" CHECK ("conversations"."priority" in ('urgent','high','normal','low')),
	CONSTRAINT "conversations_resolved_by_check" CHECK ("conversations"."resolved_by" is null or "conversations"."resolved_by" in ('ai','human')),
	CONSTRAINT "conversations_last_direction_check" CHECK ("conversations"."last_message_direction" in ('in','out'))
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"status" text,
	"external_id" text,
	"provider_message_id" text,
	"client_id" text,
	"body" text DEFAULT '' NOT NULL,
	"media" jsonb,
	"sender_kind" text NOT NULL,
	"sender_id" text,
	"sender_name" text DEFAULT '' NOT NULL,
	"error" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('in','out','internal')),
	CONSTRAINT "messages_kind_check" CHECK ("messages"."kind" in ('text','audio','image','document','note','event')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" is null or "messages"."status" in ('sending','sent','delivered','read','failed')),
	CONSTRAINT "messages_sender_kind_check" CHECK ("messages"."sender_kind" in ('contact','member','agent','system'))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quick_replies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"shortcut" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_shortcut_check" CHECK ("quick_replies"."shortcut" ~ '^[a-z0-9_-]+$')
);
--> statement-breakpoint
ALTER TABLE "quick_replies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"priority" text DEFAULT 'medium' NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"assignee_id" text NOT NULL,
	"contact_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_priority_check" CHECK ("tasks"."priority" in ('urgent','high','medium','low'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"rendered_text" text,
	"variation_id" uuid,
	"variation_number" integer,
	"interval_seconds" integer,
	"long_pause_seconds" integer,
	"day_index" integer,
	"external_id" text NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"attempted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipients_campaign_contact_unique" UNIQUE("campaign_id","contact_id"),
	CONSTRAINT "campaign_recipients_status_check" CHECK ("campaign_recipients"."status" in ('queued','sent','delivered','read','replied','failed','opted_out','no_whatsapp','skipped'))
);
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'internal' NOT NULL,
	"meta_status" text,
	"meta_name" text,
	"meta_language" text,
	"meta_params" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_templates_type_check" CHECK ("campaign_templates"."type" in ('text','text_image','buttons','list')),
	CONSTRAINT "campaign_templates_source_check" CHECK ("campaign_templates"."source" in ('internal','meta')),
	CONSTRAINT "campaign_templates_meta_status_check" CHECK ("campaign_templates"."meta_status" is null or "campaign_templates"."meta_status" in ('approved','pending','rejected')),
	CONSTRAINT "campaign_templates_meta_check" CHECK ("campaign_templates"."source" = 'internal' or "campaign_templates"."meta_status" is not null)
);
--> statement-breakpoint
ALTER TABLE "campaign_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_terms_acceptance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_terms_org_version_unique" UNIQUE("organization_id","version")
);
--> statement-breakpoint
ALTER TABLE "campaign_terms_acceptance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaign_variations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"review" text DEFAULT 'pending' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_variations_review_check" CHECK ("campaign_variations"."review" in ('pending','approved','rejected'))
);
--> statement-breakpoint
ALTER TABLE "campaign_variations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience_id" uuid,
	"audience_name" text,
	"audience_snapshot" jsonb,
	"channel_id" uuid,
	"channel_name" text,
	"channel_kind" text,
	"message_type" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"image_name" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"list_button_label" text DEFAULT '' NOT NULL,
	"list_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opt_out_line" text NOT NULL,
	"official_template_id" uuid,
	"variation_mode" text DEFAULT 'bank' NOT NULL,
	"variations_base" text,
	"schedule_mode" text DEFAULT 'now' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"interval_min_seconds" integer DEFAULT 45 NOT NULL,
	"interval_max_seconds" integer DEFAULT 120 NOT NULL,
	"window_start" text DEFAULT '08:00' NOT NULL,
	"window_end" text DEFAULT '20:00' NOT NULL,
	"skip_sundays_and_holidays" boolean DEFAULT true NOT NULL,
	"pause_reason" text,
	"pause_detail" text,
	"next_send_at" timestamp with time zone,
	"engine_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipients_total" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "campaigns_status_check" CHECK ("campaigns"."status" in ('draft','scheduled','sending','paused','completed','canceled')),
	CONSTRAINT "campaigns_message_type_check" CHECK ("campaigns"."message_type" in ('text','text_image','buttons','list')),
	CONSTRAINT "campaigns_variation_mode_check" CHECK ("campaigns"."variation_mode" in ('bank','per_message')),
	CONSTRAINT "campaigns_schedule_mode_check" CHECK ("campaigns"."schedule_mode" in ('now','scheduled')),
	CONSTRAINT "campaigns_channel_kind_check" CHECK ("campaigns"."channel_kind" is null or "campaigns"."channel_kind" in ('whatsapp_qr','whatsapp_official')),
	CONSTRAINT "campaigns_interval_check" CHECK ("campaigns"."interval_min_seconds" >= 30 and "campaigns"."interval_max_seconds" > "campaigns"."interval_min_seconds"),
	CONSTRAINT "campaigns_pause_reason_check" CHECK ("campaigns"."pause_reason" is null or "campaigns"."pause_reason" in ('manual','channel_disconnected','high_failure_rate','opt_outs','provider_restriction','outside_window','subscription_expired'))
);
--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_suggestions" ADD CONSTRAINT "conversation_suggestions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_suggestions" ADD CONSTRAINT "conversation_suggestions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_variation_id_campaign_variations_id_fk" FOREIGN KEY ("variation_id") REFERENCES "public"."campaign_variations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_templates" ADD CONSTRAINT "campaign_templates_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_terms_acceptance" ADD CONSTRAINT "campaign_terms_acceptance_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_variations" ADD CONSTRAINT "campaign_variations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_variations" ADD CONSTRAINT "campaign_variations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_audience_id_contact_lists_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."contact_lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_official_template_id_campaign_templates_id_fk" FOREIGN KEY ("official_template_id") REFERENCES "public"."campaign_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_suggestions_org_idx" ON "conversation_suggestions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "conversation_suggestions_conversation_idx" ON "conversation_suggestions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_org_status_last_idx" ON "conversations" USING btree ("organization_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_org_assignee_idx" ON "conversations" USING btree ("organization_id","assignee_id");--> statement-breakpoint
CREATE INDEX "conversations_org_team_idx" ON "conversations" USING btree ("organization_id","team_id");--> statement-breakpoint
CREATE INDEX "conversations_org_contact_idx" ON "conversations" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "conversations_ai_due_idx" ON "conversations" USING btree ("ai_due_at") WHERE "conversations"."ai_due_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_open_per_contact_channel" ON "conversations" USING btree ("organization_id","contact_id","channel_id") WHERE "conversations"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "messages_org_idx" ON "messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_channel_provider_idx" ON "messages" USING btree ("channel_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_body_trgm_idx" ON "messages" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "messages_channel_external_key" ON "messages" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_client_key" ON "messages" USING btree ("conversation_id","client_id");--> statement-breakpoint
CREATE INDEX "quick_replies_org_idx" ON "quick_replies" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quick_replies_org_shortcut_key" ON "quick_replies" USING btree ("organization_id",lower("shortcut"));--> statement-breakpoint
CREATE INDEX "tasks_org_assignee_idx" ON "tasks" USING btree ("organization_id","assignee_id","done");--> statement-breakpoint
CREATE INDEX "tasks_org_contact_idx" ON "tasks" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_external_id_key" ON "campaign_recipients" USING btree ("organization_id","external_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_org_idx" ON "campaign_recipients" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_queue_idx" ON "campaign_recipients" USING btree ("campaign_id","status","position");--> statement-breakpoint
CREATE INDEX "campaign_recipients_contact_idx" ON "campaign_recipients" USING btree ("contact_id","sent_at");--> statement-breakpoint
CREATE INDEX "campaign_recipients_provider_msg_idx" ON "campaign_recipients" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "campaign_recipients_attempted_idx" ON "campaign_recipients" USING btree ("campaign_id","attempted_at");--> statement-breakpoint
CREATE INDEX "campaign_templates_org_idx" ON "campaign_templates" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "campaign_terms_org_idx" ON "campaign_terms_acceptance" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "campaign_variations_org_idx" ON "campaign_variations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "campaign_variations_campaign_idx" ON "campaign_variations" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_org_updated_idx" ON "campaigns" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "campaigns_due_idx" ON "campaigns" USING btree ("status","next_send_at");--> statement-breakpoint
CREATE INDEX "campaigns_channel_idx" ON "campaigns" USING btree ("channel_id");--> statement-breakpoint
CREATE POLICY "conversation_suggestions_tenant_isolation" ON "conversation_suggestions" AS PERMISSIVE FOR ALL TO public USING ("conversation_suggestions"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("conversation_suggestions"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "conversations_tenant_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING ("conversations"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("conversations"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "messages_tenant_isolation" ON "messages" AS PERMISSIVE FOR ALL TO public USING ("messages"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("messages"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "quick_replies_tenant_isolation" ON "quick_replies" AS PERMISSIVE FOR ALL TO public USING ("quick_replies"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("quick_replies"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "tasks_tenant_isolation" ON "tasks" AS PERMISSIVE FOR ALL TO public USING ("tasks"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("tasks"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "campaign_recipients_tenant_isolation" ON "campaign_recipients" AS PERMISSIVE FOR ALL TO public USING ("campaign_recipients"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("campaign_recipients"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "campaign_templates_tenant_isolation" ON "campaign_templates" AS PERMISSIVE FOR ALL TO public USING ("campaign_templates"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("campaign_templates"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "campaign_terms_acceptance_tenant_isolation" ON "campaign_terms_acceptance" AS PERMISSIVE FOR ALL TO public USING ("campaign_terms_acceptance"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("campaign_terms_acceptance"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "campaign_variations_tenant_isolation" ON "campaign_variations" AS PERMISSIVE FOR ALL TO public USING ("campaign_variations"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("campaign_variations"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "campaigns_tenant_isolation" ON "campaigns" AS PERMISSIVE FOR ALL TO public USING ("campaigns"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("campaigns"."organization_id" = current_setting('app.org_id', true));