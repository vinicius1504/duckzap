# Painel super admin (apps/admin, Next.js 16, porta 3002). Construir a partir da RAIZ do monorepo:
#   docker build -f apps/admin/Dockerfile -t duckchat-admin .
# Mesmo desenho do apps/web/Dockerfile: `next build` com output "standalone", runtime só com o necessário, usuário não-root.
# O admin não tem rewrites nem NEXT_PUBLIC_*: nada de configuração entra no build. Em EXECUÇÃO ele lê
# API_INTERNAL_URL (chamadas servidor→API) e ADMIN_URL (origem que a API confere nas escritas). Sem segredo na imagem.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# o typecheck do `next build` precisa dos tipos da API (via @duckzap/api-client), por isso api e seus pacotes entram na instalação
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json apps/admin/
COPY apps/api/package.json apps/api/
COPY packages/ai/package.json packages/ai/
COPY packages/api-client/package.json packages/api-client/
COPY packages/brand/package.json packages/brand/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@duckzap/admin..."

COPY apps/admin apps/admin
COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @duckzap/admin build

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3002 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/admin/.next/static ./apps/admin/.next/static
USER node
EXPOSE 3002
# qualquer resposta HTTP abaixo de 500 em /entrar (página pública) prova que o Next atende; não depende da API
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/entrar',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/admin/server.js"]
