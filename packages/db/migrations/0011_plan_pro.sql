-- O teste grátis do cadastro usa o plano "pro" (onboarding/routes.ts), mas as migrações anteriores só o atualizavam (0005):
-- em banco novo (produção) ele não existia e o cadastro falhava na FK de subscriptions. Garante a linha; não altera uma já existente.
INSERT INTO "plans" ("slug", "name", "max_channels", "max_users", "max_agents", "features", "monthly_token_limit", "active") VALUES
  ('pro', 'Pro', 5, 5, NULL, ARRAY['campaigns','instagram'], 8000000, true)
ON CONFLICT ("slug") DO NOTHING;
