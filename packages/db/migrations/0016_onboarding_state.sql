-- Estado durável do cadastro (/comecar): antes ficava na memória do servidor do front e sumia a cada deploy.
ALTER TABLE "organization" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "onboarding_whatsapp_skipped_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: toda empresa que já existe conta como cadastro concluído (o onboarding passa a ser obrigatório e ninguém
-- que já usa o app pode ser mandado de volta a /comecar). Só empresas criadas depois desta migração começam em null.
UPDATE "organization" SET "onboarding_completed_at" = "created_at" WHERE "onboarding_completed_at" IS NULL;
