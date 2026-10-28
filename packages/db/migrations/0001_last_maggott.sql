CREATE TABLE "admin_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"pending_totp_secret_enc" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_challenges_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"actor_email" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text NOT NULL,
	"company_id" text,
	"company_name" text,
	"reason" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip" text,
	CONSTRAINT "audit_logs_kind_check" CHECK ("audit_logs"."kind" in ('mutation','auth')),
	CONSTRAINT "audit_logs_reason_check" CHECK ("audit_logs"."kind" = 'auth' or char_length(btrim("audit_logs"."reason")) >= 10)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"number" text NOT NULL,
	"amount_cents" integer,
	"due_date" date NOT NULL,
	"status" text NOT NULL,
	"paid_at" timestamp with time zone,
	"method" text,
	"gateway_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('paid','open','overdue','void')),
	CONSTRAINT "invoices_method_check" CHECK ("invoices"."method" is null or "invoices"."method" in ('pix','boleto','card')),
	CONSTRAINT "invoices_amount_check" CHECK ("invoices"."amount_cents" is null or "invoices"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" integer,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite_profiles" (
	"invitation_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invite_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "member_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"phone" text,
	"two_factor_enabled_at" timestamp with time zone,
	"notifications" jsonb DEFAULT '{"sound":true,"browser":true,"emailSummary":false}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_profiles_org_user_unique" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "member_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"member_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_ref_unique" UNIQUE("team_id","member_ref")
);
--> statement-breakpoint
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"priority" integer NOT NULL,
	"business_hours" jsonb NOT NULL,
	"greeting" text DEFAULT '' NOT NULL,
	"out_of_hours_message" text DEFAULT '' NOT NULL,
	"channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_outbound" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error_code" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_outbound_status_check" CHECK ("channel_outbound"."status" in ('sending','sent','failed'))
);
--> statement-breakpoint
ALTER TABLE "channel_outbound" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"address" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"team_id" text,
	"agent_id" text,
	"welcome_message" text DEFAULT '' NOT NULL,
	"out_of_hours_message" text DEFAULT '' NOT NULL,
	"closing_message" text DEFAULT '' NOT NULL,
	"rating_message" text DEFAULT '' NOT NULL,
	"inactivity_transfer_minutes" integer DEFAULT 30 NOT NULL,
	"credentials_enc" text,
	"credentials_hint" text,
	"webhook_token_hash" text NOT NULL,
	"webhook_token_enc" text NOT NULL,
	"qr_payload_enc" text,
	"qr_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_change_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_type_check" CHECK ("channels"."type" in ('whatsapp_qr','whatsapp_official','instagram')),
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" in ('connected','qr_pending','awaiting_authorization','disconnected','banned')),
	CONSTRAINT "channels_inactivity_check" CHECK ("channels"."inactivity_transfer_minutes" in (10,30,60))
);
--> statement-breakpoint
ALTER TABLE "channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"event" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "inbound_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"invite_text" text,
	"invite_queued_at" timestamp with time zone,
	"invite_scheduled_for" date,
	"invite_sent_at" timestamp with time zone,
	"reply_text" text,
	"replied_at" timestamp with time zone,
	"channel_id" text,
	"channel_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_org_contact_unique" UNIQUE("organization_id","contact_id"),
	CONSTRAINT "consents_status_check" CHECK ("consents"."status" in ('pending','granted','denied','expired')),
	CONSTRAINT "consents_method_check" CHECK ("consents"."method" in ('invite','conversation','form'))
);
--> statement-breakpoint
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_events_kind_check" CHECK ("contact_events"."kind" in ('conversation','appointment','campaign','consent','tag','import','created'))
);
--> statement-breakpoint
ALTER TABLE "contact_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"file_name" text NOT NULL,
	"rows" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_list_members" (
	"organization_id" text NOT NULL,
	"list_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_list_members_list_id_contact_id_pk" PRIMARY KEY("list_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "contact_list_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"filter" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_lists_kind_check" CHECK ("contact_lists"."kind" in ('static','segment')),
	CONSTRAINT "contact_lists_segment_filter_check" CHECK ("contact_lists"."kind" <> 'segment' or "contact_lists"."filter" is not null)
);
--> statement-breakpoint
ALTER TABLE "contact_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tags_contact_id_tag_id_pk" PRIMARY KEY("contact_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "contact_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"instagram" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"origin" text,
	"origin_note" text,
	"owner_id" text,
	"birth_date" date,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_interaction_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_org_phone_unique" UNIQUE("organization_id","phone"),
	CONSTRAINT "contacts_origin_check" CHECK ("contacts"."origin" is null or "contacts"."origin" in ('customer','service','form','walk_in','event','referral','inbound'))
);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL,
	"funnel_stage" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_color_check" CHECK ("tags"."color" in ('ink','duck','slate','ok','info','warn','err')),
	CONSTRAINT "tags_funnel_stage_check" CHECK ("tags"."funnel_stage" is null or "tags"."funnel_stage" between 1 and 4)
);
--> statement-breakpoint
ALTER TABLE "tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agenda_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"confirm_by_reply" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agenda_settings_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "agenda_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointment_reminder_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"message" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_reminder_settings_org_kind_unique" UNIQUE("organization_id","kind"),
	CONSTRAINT "appointment_reminder_settings_kind_check" CHECK ("appointment_reminder_settings"."kind" in ('24h','2h'))
);
--> statement-breakpoint
ALTER TABLE "appointment_reminder_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointment_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"appointment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_reminders_appt_kind_unique" UNIQUE("appointment_id","kind"),
	CONSTRAINT "appointment_reminders_kind_check" CHECK ("appointment_reminders"."kind" in ('24h','2h')),
	CONSTRAINT "appointment_reminders_status_check" CHECK ("appointment_reminders"."status" in ('scheduled','sent','skipped'))
);
--> statement-breakpoint
ALTER TABLE "appointment_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointment_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"staff_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_types_duration_check" CHECK ("appointment_types"."duration_minutes" between 5 and 480)
);
--> statement-breakpoint
ALTER TABLE "appointment_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_name" text,
	"notes" text,
	"confirmation_reply" text,
	"allow_conflict" boolean DEFAULT false NOT NULL,
	"synced_to_google" boolean DEFAULT false NOT NULL,
	"google_event_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" in ('pending','confirmed','reschedule','done','canceled')),
	CONSTRAINT "appointments_source_check" CHECK ("appointments"."source" in ('manual','ai_agent','google')),
	CONSTRAINT "appointments_range_check" CHECK ("appointments"."ends_at" > "appointments"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "calendar_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"calendar_name" text,
	"account_email" text,
	"last_synced_at" timestamp with time zone,
	"error_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_syncs_organizationId_unique" UNIQUE("organization_id"),
	CONSTRAINT "calendar_syncs_status_check" CHECK ("calendar_syncs"."status" in ('synced','syncing','error','disconnected'))
);
--> statement-breakpoint
ALTER TABLE "calendar_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"pages" integer,
	"status" text DEFAULT 'processing' NOT NULL,
	"error" text,
	"extracted_text" text,
	"created_by" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_documents_kind_check" CHECK ("agent_documents"."kind" in ('pdf','docx','txt')),
	CONSTRAINT "agent_documents_status_check" CHECK ("agent_documents"."status" in ('processing','ready','failed'))
);
--> statement-breakpoint
ALTER TABLE "agent_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"config" jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_number_key" UNIQUE("agent_id","number")
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"job" text NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"teams" text[] DEFAULT '{}'::text[] NOT NULL,
	"channel_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"paused_reason" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_job_check" CHECK ("agents"."job" in ('support','follow_up','scheduling','instagram_dm','comments')),
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" in ('active','paused','inactive'))
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_usage_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text,
	"conversation_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_ai_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"agent_id" text,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"event" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_ai_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "copilot_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"verdict" text NOT NULL,
	"suggestion" text NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_feedback_verdict_check" CHECK ("copilot_feedback"."verdict" in ('useful','bad'))
);
--> statement-breakpoint
ALTER TABLE "copilot_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "copilot_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"teams" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_settings_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "copilot_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"document_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('portuguese', content)) STORED,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text DEFAULT 'dz_live_' NOT NULL,
	"last4" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"display_name" text,
	"last_sync_at" timestamp with time zone,
	"secret_encrypted" text,
	"secret_last4" text,
	"phone_number_id_last4" text,
	"verify_token" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_org_provider_unique" UNIQUE("organization_id","provider")
);
--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"segment" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"business_hours" jsonb NOT NULL,
	"welcome_message" text DEFAULT '' NOT NULL,
	"follow_up" jsonb NOT NULL,
	"inactivity_close" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"secret_encrypted" text NOT NULL,
	"secret_last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_delivery_status" integer,
	"last_delivery_ok" boolean,
	CONSTRAINT "webhook_endpoints_org_url_unique" UNIQUE("organization_id","url")
);
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "checkout_url" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "on_trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cycle" text DEFAULT 'monthly' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "gateway" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "gateway_reference" text;--> statement-breakpoint
ALTER TABLE "admin_challenges" ADD CONSTRAINT "admin_challenges_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_profiles" ADD CONSTRAINT "invite_profiles_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_profiles" ADD CONSTRAINT "invite_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_outbound" ADD CONSTRAINT "channel_outbound_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_outbound" ADD CONSTRAINT "channel_outbound_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_imports" ADD CONSTRAINT "contact_imports_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_lists" ADD CONSTRAINT "contact_lists_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agenda_settings" ADD CONSTRAINT "agenda_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminder_settings" ADD CONSTRAINT "appointment_reminder_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_types" ADD CONSTRAINT "appointment_types_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_type_id_appointment_types_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."appointment_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_syncs" ADD CONSTRAINT "calendar_syncs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_documents" ADD CONSTRAINT "agent_documents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_log" ADD CONSTRAINT "ai_usage_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_ai_events" ADD CONSTRAINT "conversation_ai_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_feedback" ADD CONSTRAINT "copilot_feedback_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copilot_settings" ADD CONSTRAINT "copilot_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_agent_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."agent_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_challenges_admin_id_idx" ON "admin_challenges" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_admin_id_idx" ON "admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_company_idx" ON "audit_logs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "invoices_subscription_idx" ON "invoices" USING btree ("subscription_id","due_date" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "invite_profiles_organization_id_idx" ON "invite_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_profiles_organization_id_idx" ON "member_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "team_members_organization_id_idx" ON "team_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "team_members_member_ref_idx" ON "team_members" USING btree ("member_ref");--> statement-breakpoint
CREATE INDEX "teams_organization_id_idx" ON "teams" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "channel_outbound_organization_id_idx" ON "channel_outbound" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_outbound_channel_external_key" ON "channel_outbound" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "channels_organization_id_idx" ON "channels" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_webhook_token_hash_key" ON "channels" USING btree ("webhook_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_org_name_key" ON "channels" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "channels_one_default_per_org" ON "channels" USING btree ("organization_id") WHERE "channels"."is_default";--> statement-breakpoint
CREATE INDEX "inbound_events_organization_id_idx" ON "inbound_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_channel_external_key" ON "inbound_events" USING btree ("channel_id","external_id");--> statement-breakpoint
CREATE INDEX "inbound_events_pending_idx" ON "inbound_events" USING btree ("received_at") WHERE "inbound_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "consents_org_status_idx" ON "consents" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "consents_org_channel_queued_idx" ON "consents" USING btree ("organization_id","channel_id","invite_queued_at");--> statement-breakpoint
CREATE INDEX "contact_events_org_idx" ON "contact_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_events_contact_idx" ON "contact_events" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_imports_org_idx" ON "contact_imports" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_list_members_org_idx" ON "contact_list_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_list_members_contact_idx" ON "contact_list_members" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_lists_org_idx" ON "contact_lists" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_lists_org_name_unique" ON "contact_lists" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "contact_notes_org_idx" ON "contact_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_notes_contact_idx" ON "contact_notes" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_tags_org_idx" ON "contact_tags" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_tags_tag_idx" ON "contact_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "contacts_org_created_idx" ON "contacts" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_org_owner_idx" ON "contacts" USING btree ("organization_id","owner_id");--> statement-breakpoint
CREATE INDEX "contacts_name_trgm_idx" ON "contacts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_phone_trgm_idx" ON "contacts" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_email_trgm_idx" ON "contacts" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tags_org_position_idx" ON "tags" USING btree ("organization_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_name_unique" ON "tags" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "appointment_reminders_org_idx" ON "appointment_reminders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "appointment_reminders_due_idx" ON "appointment_reminders" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "appointment_types_org_idx" ON "appointment_types" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_types_org_name_unique" ON "appointment_types" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "appointments_org_starts_idx" ON "appointments" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_org_owner_starts_idx" ON "appointments" USING btree ("organization_id","owner_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_org_contact_idx" ON "appointments" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE INDEX "agent_documents_organization_id_idx" ON "agent_documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agent_documents_agent_id_idx" ON "agent_documents" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_versions_organization_id_idx" ON "agent_versions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "agents_organization_id_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_usage_log_organization_id_idx" ON "ai_usage_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_log_conversation_idx" ON "ai_usage_log" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_ai_events_organization_id_idx" ON "conversation_ai_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_ai_events_conversation_idx" ON "conversation_ai_events" USING btree ("organization_id","conversation_id");--> statement-breakpoint
CREATE INDEX "copilot_feedback_organization_id_idx" ON "copilot_feedback" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "copilot_settings_organization_id_idx" ON "copilot_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_organization_id_idx" ON "knowledge_chunks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_agent_id_idx" ON "knowledge_chunks" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search_vector_idx" ON "knowledge_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_content_trgm_idx" ON "knowledge_chunks" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "integrations_organization_id_idx" ON "integrations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_organization_id_idx" ON "webhook_endpoints" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "subscriptions_plan_slug_idx" ON "subscriptions" USING btree ("plan_slug");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_cycle_check" CHECK ("subscriptions"."cycle" in ('monthly','yearly'));--> statement-breakpoint
CREATE POLICY "invite_profiles_tenant_isolation" ON "invite_profiles" AS PERMISSIVE FOR ALL TO public USING ("invite_profiles"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("invite_profiles"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "member_profiles_tenant_isolation" ON "member_profiles" AS PERMISSIVE FOR ALL TO public USING ("member_profiles"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("member_profiles"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "team_members_tenant_isolation" ON "team_members" AS PERMISSIVE FOR ALL TO public USING ("team_members"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("team_members"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "teams_tenant_isolation" ON "teams" AS PERMISSIVE FOR ALL TO public USING ("teams"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("teams"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "channel_outbound_tenant_isolation" ON "channel_outbound" AS PERMISSIVE FOR ALL TO public USING ("channel_outbound"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("channel_outbound"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "channels_tenant_isolation" ON "channels" AS PERMISSIVE FOR ALL TO public USING ("channels"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("channels"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "inbound_events_tenant_isolation" ON "inbound_events" AS PERMISSIVE FOR ALL TO public USING ("inbound_events"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("inbound_events"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "consents_tenant_isolation" ON "consents" AS PERMISSIVE FOR ALL TO public USING ("consents"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("consents"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contact_events_tenant_isolation" ON "contact_events" AS PERMISSIVE FOR ALL TO public USING ("contact_events"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contact_events"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contact_imports_tenant_isolation" ON "contact_imports" AS PERMISSIVE FOR ALL TO public USING ("contact_imports"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contact_imports"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contact_list_members_tenant_isolation" ON "contact_list_members" AS PERMISSIVE FOR ALL TO public USING ("contact_list_members"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contact_list_members"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contact_lists_tenant_isolation" ON "contact_lists" AS PERMISSIVE FOR ALL TO public USING ("contact_lists"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contact_lists"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contact_notes_tenant_isolation" ON "contact_notes" AS PERMISSIVE FOR ALL TO public USING ("contact_notes"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contact_notes"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contact_tags_tenant_isolation" ON "contact_tags" AS PERMISSIVE FOR ALL TO public USING ("contact_tags"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contact_tags"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "contacts_tenant_isolation" ON "contacts" AS PERMISSIVE FOR ALL TO public USING ("contacts"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("contacts"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "tags_tenant_isolation" ON "tags" AS PERMISSIVE FOR ALL TO public USING ("tags"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("tags"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "agenda_settings_tenant_isolation" ON "agenda_settings" AS PERMISSIVE FOR ALL TO public USING ("agenda_settings"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("agenda_settings"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "appointment_reminder_settings_tenant_isolation" ON "appointment_reminder_settings" AS PERMISSIVE FOR ALL TO public USING ("appointment_reminder_settings"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("appointment_reminder_settings"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "appointment_reminders_tenant_isolation" ON "appointment_reminders" AS PERMISSIVE FOR ALL TO public USING ("appointment_reminders"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("appointment_reminders"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "appointment_types_tenant_isolation" ON "appointment_types" AS PERMISSIVE FOR ALL TO public USING ("appointment_types"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("appointment_types"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "appointments_tenant_isolation" ON "appointments" AS PERMISSIVE FOR ALL TO public USING ("appointments"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("appointments"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "calendar_syncs_tenant_isolation" ON "calendar_syncs" AS PERMISSIVE FOR ALL TO public USING ("calendar_syncs"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("calendar_syncs"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "agent_documents_tenant_isolation" ON "agent_documents" AS PERMISSIVE FOR ALL TO public USING ("agent_documents"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("agent_documents"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "agent_versions_tenant_isolation" ON "agent_versions" AS PERMISSIVE FOR ALL TO public USING ("agent_versions"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("agent_versions"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "agents_tenant_isolation" ON "agents" AS PERMISSIVE FOR ALL TO public USING ("agents"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("agents"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "ai_usage_log_tenant_isolation" ON "ai_usage_log" AS PERMISSIVE FOR ALL TO public USING ("ai_usage_log"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("ai_usage_log"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "conversation_ai_events_tenant_isolation" ON "conversation_ai_events" AS PERMISSIVE FOR ALL TO public USING ("conversation_ai_events"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("conversation_ai_events"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "copilot_feedback_tenant_isolation" ON "copilot_feedback" AS PERMISSIVE FOR ALL TO public USING ("copilot_feedback"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("copilot_feedback"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "copilot_settings_tenant_isolation" ON "copilot_settings" AS PERMISSIVE FOR ALL TO public USING ("copilot_settings"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("copilot_settings"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "knowledge_chunks_tenant_isolation" ON "knowledge_chunks" AS PERMISSIVE FOR ALL TO public USING ("knowledge_chunks"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("knowledge_chunks"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO public USING ("api_keys"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("api_keys"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "integrations_tenant_isolation" ON "integrations" AS PERMISSIVE FOR ALL TO public USING ("integrations"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("integrations"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "organization_settings_tenant_isolation" ON "organization_settings" AS PERMISSIVE FOR ALL TO public USING ("organization_settings"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("organization_settings"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "webhook_endpoints_tenant_isolation" ON "webhook_endpoints" AS PERMISSIVE FOR ALL TO public USING ("webhook_endpoints"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("webhook_endpoints"."organization_id" = current_setting('app.org_id', true));