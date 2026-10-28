# Imagem do serviço "backup". Construir a partir da RAIZ do repositório:
#   docker build -f deploy/backup.Dockerfile -t duckchat-backup .
# Base postgres:17-alpine = mesmo pg_dump 17 do servidor. Acrescenta age (cifra), rclone (R2), curl (heartbeat) e tzdata.
# Roda como o usuário "postgres" (não-root). Sem segredo na imagem: tudo por variáveis de ambiente.
FROM postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b
RUN apk add --no-cache age rclone curl tzdata
COPY deploy/backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh
ENV HOME=/tmp
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
