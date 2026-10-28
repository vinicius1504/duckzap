# App das empresas (apps/web, Next.js 16, porta 3000). Construir a partir da RAIZ do monorepo:
#   docker build -f apps/web/Dockerfile -t duckchat-web .
# Duas etapas: "build" roda `next build` (next.config.ts tem output "standalone") e "runtime" leva só a pasta
# standalone + os estáticos, como usuário não-root. Sem segredo na imagem.
#
# O que entra no BUILD (build-args, valores públicos, nunca segredos):
#   API_INTERNAL_URL         destino dos rewrites de /api/v1/auth e /api/v1/me; o next.config.ts lê isto na hora do build e
#                            grava no routes-manifest. Em produção o Caddy atende essas rotas direto na API, então o valor
#                            só importa como reserva. Padrão: o nome do serviço no compose.
#   NEXT_PUBLIC_REALTIME_URL vazio = o navegador usa wss://<mesmo host>/ws (é o desenho do Caddy). Só preencha se o
#                            realtime ficar em OUTRO host (a origem entra no connect-src da CSP). Mudou = rebuild.
# O que é lido em EXECUÇÃO (variáveis do contêiner): API_INTERNAL_URL (chamadas servidor→API) e WEB_URL. Ver deploy/.env.production.example.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# o typecheck do `next build` precisa dos tipos da API (via @duckzap/api-client), por isso api e seus pacotes entram na instalação
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/ai/package.json packages/ai/
COPY packages/api-client/package.json packages/api-client/
COPY packages/brand/package.json packages/brand/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@duckzap/web..."

COPY apps/web apps/web
COPY apps/api apps/api
COPY packages packages

ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_REALTIME_URL=
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
RUN pnpm --filter @duckzap/web build

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# standalone mantém a estrutura do monorepo: o servidor fica em apps/web/server.js
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
# qualquer resposta HTTP abaixo de 500 em /entrar (página pública) prova que o Next atende; não depende da API
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/entrar',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
