-- Modo de resposta do canal (ai | auto). Todo canal existente fica em 'ai' (default): os textos de boas-vindas e fora do horário
-- já gravados são preservados, mas deixam de ser enviados; quem quiser mensagens automáticas muda o canal para 'auto'.
ALTER TABLE "channels" ADD COLUMN "reply_mode" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_reply_mode_check" CHECK ("channels"."reply_mode" in ('ai','auto'));