ALTER TABLE "contacts" ADD COLUMN "avatar_media_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "avatar_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_avatar_media_id_media_files_id_fk" FOREIGN KEY ("avatar_media_id") REFERENCES "public"."media_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_avatar_media_idx" ON "contacts" USING btree ("avatar_media_id") WHERE "contacts"."avatar_media_id" is not null;