# API do DuckChat (apps/api). Construir a partir da RAIZ do monorepo:
#   docker build -f apps/api/Dockerfile -t duckchat-api .
# Duas etapas: "build" instala tudo e gera dist/ (tsup embute os pacotes @duckzap/*); "runtime" leva só
# dist/ e as dependências de produção, roda como usuário não-root e não traz código-fonte nem devDependencies.
# Configuração é só por variáveis de ambiente (apps/api/.env.example); NADA de segredo na imagem.
#
# A mesma imagem leva as ferramentas de banco (db/scripts/migrate.js e setup-roles.js, com db/migrations):
# o serviço "migrate" do deploy/docker-compose.prod.yml roda `node db/scripts/migrate.js` com esta imagem,
# então não existe uma imagem extra só para migrar.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# manifestos primeiro: a camada de instalação só é refeita quando as dependências mudam
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/ai/package.json packages/ai/
COPY packages/brand/package.json packages/brand/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@duckzap/api..."

COPY apps/api apps/api
COPY packages packages
COPY deploy/db-tools.tsup.config.ts deploy/db-tools.tsup.config.ts
RUN pnpm --filter @duckzap/api build
# só as dependências de produção do pacote da API (sem devDependencies)
RUN pnpm --filter @duckzap/api deploy --prod /out || pnpm --filter @duckzap/api deploy --prod --legacy /out
RUN cp -r apps/api/dist /out/dist
# ferramentas de banco: scripts em JS puro + pasta de migrations (o migrate.js lê ../migrations a partir dele)
RUN cd apps/api && pnpm exec tsup --config /repo/deploy/db-tools.tsup.config.ts \
 && cp -r /repo/packages/db/migrations /out/db/migrations

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM chega direto ao node (sem shell no meio): o shutdown ordenado do index.ts roda
CMD ["node", "--enable-source-maps", "dist/index.js"]
