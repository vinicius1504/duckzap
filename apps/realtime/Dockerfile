# Servidor de tempo real (apps/realtime, WebSocket). Construir a partir da RAIZ do monorepo:
#   docker build -f apps/realtime/Dockerfile -t duckchat-realtime .
# Mesmo desenho da API: "build" gera dist/ (tsup embute @duckzap/*) e "runtime" leva só dist/ + dependências de
# produção, como usuário não-root. Configuração só por variáveis de ambiente (apps/realtime/.env.example); sem segredo na imagem.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/realtime/package.json apps/realtime/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@duckzap/realtime..."

COPY apps/realtime apps/realtime
COPY packages/config packages/config
COPY packages/contracts packages/contracts
RUN pnpm --filter @duckzap/realtime build
RUN pnpm --filter @duckzap/realtime deploy --prod /out || pnpm --filter @duckzap/realtime deploy --prod --legacy /out
RUN cp -r apps/realtime/dist /out/dist

FROM node:24-slim AS runtime
ENV NODE_ENV=production REALTIME_PORT=4001 REALTIME_HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4001
# /health responde 200 mesmo com o Valkey fora ({"redis":"down"}): o healthcheck só prova que o processo atende
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REALTIME_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# SIGTERM chega direto ao node: o desligamento ordenado (close 4503) roda
CMD ["node", "--enable-source-maps", "dist/index.js"]
