CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_seconds" integer,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"direction" text NOT NULL,
	"created_by" text,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "media_files_kind_check" CHECK ("media_files"."kind" in ('image','document','audio')),
	CONSTRAINT "media_files_status_check" CHECK ("media_files"."status" in ('uploading','ready','deleted')),
	CONSTRAINT "media_files_direction_check" CHECK ("media_files"."direction" in ('out','in'))
);
--> statement-breakpoint
ALTER TABLE "media_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_storage_key_key" ON "media_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_files_org_status_created_idx" ON "media_files" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "media_files_message_idx" ON "media_files" USING btree ("message_id");--> statement-breakpoint
CREATE POLICY "media_files_tenant_isolation" ON "media_files" AS PERMISSIVE FOR ALL TO public USING ("media_files"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("media_files"."organization_id" = current_setting('app.org_id', true));