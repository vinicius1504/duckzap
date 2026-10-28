# Runbook — criar o primeiro admin do painel (produção)

O painel (`apps/admin`) tem login próprio (tabela `platform_admins`, cookie `dz_admin`). Em produção o **primeiro acesso exige um código de ativação**, para que a senha sozinha não permita cadastrar o próprio app autenticador (TOTP).

Quem executa precisa de acesso ao servidor (variáveis `DATABASE_ADMIN_URL` do dono do banco, `ADMIN_DATABASE_URL` e `ENCRYPTION_KEY` da API). Nada disto é feito pelo navegador.

## Passo a passo

1. **Escolha uma senha forte** (16+ caracteres, gerada num gerenciador). Nunca use a de desenvolvimento (`<senha-forte-que-so-voce-sabe>`): fora de um banco local o `seed-admin` recusa senhas fracas ou com menos de 16 caracteres.
2. **Crie o admin** com o seed, no banco de produção, informando a senha só por variável de ambiente:
   `ADMIN_SEED_PASSWORD='<senha forte>' DATABASE_ADMIN_URL='<url do dono>' pnpm --filter @duckzap/db exec tsx scripts/seed-admin.ts`
   (o script recusa `NODE_ENV=production` de propósito: rode sem essa variável e, antes de rodar, ajuste a lista `admins` do arquivo para as pessoas reais; **não** deixe os e-mails de exemplo em produção).
3. **Gere o código de ativação** (uma vez por admin):
   `pnpm --filter @duckzap/api exec tsx --env-file-if-exists=.env scripts/admin-activation-code.ts <email-do-admin>`
   O código aparece UMA vez no terminal. Não é guardado em lugar nenhum (é derivado da `ENCRYPTION_KEY`). Entregue ao admin por **outro canal** que não o da senha.
4. **Primeiro login no painel**: e-mail + senha + código de ativação. O painel mostra a chave para cadastrar no app autenticador; ao digitar o primeiro código de 6 dígitos o 2FA fica ativo e o código de ativação deixa de valer (o admin já tem TOTP).
5. **Apague o histórico do terminal** e a senha do ambiente (`unset ADMIN_SEED_PASSWORD`).

## Variáveis

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `ADMIN_REQUIRE_ACTIVATION_CODE` | `true` em produção, `false` em dev/test | Exige o código de ativação no 1º acesso |
| `ADMIN_IP_ALLOWLIST` | vazio | Só estes IPs/CIDRs acessam `/v1/admin` |
| `ADMIN_TRUST_PROXY` | `false` | `true` só atrás de proxy confiável que acrescenta o IP ao fim de `x-forwarded-for` |

## Se o código vazou ou foi perdido

Gere outro com o mesmo comando (o código é sempre o mesmo para o mesmo admin e a mesma `ENCRYPTION_KEY`; para invalidar o antigo, troque a chave ativa em `ENCRYPTION_KEYS` ou, se o admin ainda não cadastrou o TOTP, desative-o: `update platform_admins set active=false where email=...`).

## Perdeu o celular (TOTP)

Outro super admin não consegue redefinir o 2FA pelo painel. Com acesso ao banco: `update platform_admins set totp_secret_enc=null, totp_enabled_at=null where email='...'`, gere um código de ativação novo e refaça o primeiro acesso.
