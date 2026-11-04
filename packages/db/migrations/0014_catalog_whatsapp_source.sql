ALTER TABLE "products" ADD COLUMN "source" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_channel_external_unique" ON "products" USING btree ("channel_id","external_id") WHERE "products"."channel_id" is not null and "products"."external_id" is not null;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_source_check" CHECK ("products"."source" in ('system', 'whatsapp'));