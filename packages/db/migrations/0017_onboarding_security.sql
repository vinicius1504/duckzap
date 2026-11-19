-- Passo opcional "Proteja sua conta" do cadastro (/comecar): "Pular por enquanto" fica gravado na PESSOA (o passo vem
-- antes de a empresa existir). O passo conta como feito com o 2FA ativo (user.two_factor_enabled) ou com esta data.
-- O método do 2FA (app ou e-mail) não precisa de coluna: sai de two_factor.verified (ver apps/api/src/modules/settings/account.ts).
ALTER TABLE "user" ADD COLUMN "onboarding_security_skipped_at" timestamp with time zone;
