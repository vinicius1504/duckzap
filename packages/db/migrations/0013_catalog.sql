CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_position_check" CHECK ("product_images"."position" between 0 and 2)
);
--> statement-breakpoint
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_cents" integer,
	"available" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_price_check" CHECK ("products"."price_cents" is null or "products"."price_cents" between 0 and 1000000000),
	CONSTRAINT "products_description_check" CHECK (char_length("products"."description") <= 500)
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_media_id_media_files_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_product_position_unique" ON "product_images" USING btree ("product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_images_media_unique" ON "product_images" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "product_images_org_idx" ON "product_images" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "products" USING btree ("organization_id","available");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_name_unique" ON "products" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE POLICY "product_images_tenant_isolation" ON "product_images" AS PERMISSIVE FOR ALL TO public USING ("product_images"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("product_images"."organization_id" = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products" AS PERMISSIVE FOR ALL TO public USING ("products"."organization_id" = current_setting('app.org_id', true)) WITH CHECK ("products"."organization_id" = current_setting('app.org_id', true));