CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_org_user_created_idx" ON "notifications" USING btree ("organization_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_org_user_unread_idx" ON "notifications" USING btree ("organization_id","user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_org_read_at_idx" ON "notifications" USING btree ("organization_id","read_at") WHERE "notifications"."read_at" is not null;--> statement-breakpoint
CREATE POLICY "notifications_tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING ("notifications"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("notifications"."organization_id" = current_setting('app.org_id', true));