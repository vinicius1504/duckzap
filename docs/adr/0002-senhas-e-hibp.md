# ADR 0002 — Senhas: scrypt do Better Auth e checagem de senha vazada (HIBP)

- Status: aceito (HIBP planejado)
- Data: 2026-10-27

## Contexto

A revisão de segurança apontou dois pontos sobre senhas: (B4) o hash usado pelo Better Auth é scrypt, e a política só exige 8 a 128 caracteres; (B5) o painel admin trava a conta depois de erros de senha, o que permite a alguém travar um admin de propósito.

## Decisão

1. **Hash: ficamos com o scrypt do Better Auth** (`better-auth/crypto`, parâmetros padrão: N=16384, r=16, p=1, sal aleatório, comparação em tempo constante). É um algoritmo de senha com custo de memória, aceito pelo OWASP; trocar por argon2 exigiria um adaptador próprio sem ganho que justifique o risco agora. Os admins do painel usam o mesmo `hashPassword`.
2. **Checagem de senhas vazadas (HIBP, "Pwned Passwords" por k-anonymity) é PLANEJADA**, ainda sem código. Desenho: no cadastro, na troca e na redefinição de senha, calcular SHA-1, enviar só os 5 primeiros caracteres do hash à API `range` e recusar a senha se o restante aparecer na resposta. Se a API estiver fora do ar, **não bloquear** o cadastro (falha aberta, com log). Entra como `hooks.before` do Better Auth em `apps/api/src/auth.ts`.
3. **Trava de conta do admin (B5)**: o painel mantém o bloqueio temporário por falhas (`failedAttempts`/`lockedUntil`) porque o painel tem poucos usuários, todos conhecidos, e o ganho de impedir adivinhação supera o risco de alguém travar um admin. Mitigações já existentes: allowlist de IP opcional (`ADMIN_IP_ALLOWLIST`), limite por IP e por conta, o bloqueio é temporário e auditado. Se virar problema, o desbloqueio é feito por outro super admin ou direto no banco. Não há código novo para isso.
4. **Contas de clientes**: o limite de tentativas de login é por IP (Better Auth) e por e-mail (8 falhas em 15 minutos, em `apps/api/src/middleware/auth-handler.ts`, em memória com interface pronta para Redis).

## Consequências

- Enquanto o HIBP não entra, a mitigação é o tamanho mínimo (8) e o 2FA obrigatório para Proprietário/Administrador.
- Revisitar quando houver Redis (estado do limite compartilhado entre instâncias) e ao implementar o HIBP.
