# Runbook: mídia das conversas (bucket S3/R2)

Imagens, documentos e áudios das conversas ficam num bucket S3-compatível (Cloudflare R2 em produção, MinIO no desenvolvimento). Fluxo, limites e variáveis: seção "Mídia" de [backend-contract.md](../backend-contract.md). Esta página cobre a operação.

## 1. Criar o bucket no R2 (produção)

1. Cloudflare → R2 → criar bucket **privado** (sem domínio público, sem acesso `r2.dev`). Um bucket só para mídia de conversa (o de backup é outro).
2. Token de API do R2 com permissão **Object Read & Write** restrita a esse bucket. Guarde `Access Key ID` e `Secret Access Key` no `.env` da API (`MEDIA_STORAGE_ACCESS_KEY_ID`, `MEDIA_STORAGE_SECRET_ACCESS_KEY`). Nunca no front, nunca em log.
3. `MEDIA_STORAGE_ENDPOINT=https://<id-da-conta>.r2.cloudflarestorage.com`, `MEDIA_STORAGE_REGION=auto`, `MEDIA_STORAGE_BUCKET=<nome>`. Com o endpoint em https, `MEDIA_SEND_MODE=auto` entrega ao WhatsApp por URL assinada.
4. **CORS** do bucket (o navegador envia e lê o arquivo direto): origem = `WEB_URL` do app (ex.: `https://app.duckchat.com.br`), métodos `PUT`, `GET`, `HEAD`, cabeçalhos permitidos `Content-Type`, `MaxAgeSeconds` 3600. Sem CORS o upload falha no navegador (a API está certa).
5. Evolution (QR Code): o container precisa de `DATABASE_SAVE_DATA_NEW_MESSAGE=true`, senão a mídia RECEBIDA não é baixada (a mensagem entra com anexo indisponível).

Verificação rápida: enviar uma imagem pela tela; no R2 aparece `org/<id da empresa>/<ano-mes>/<uuid>`.

## 2. Arquivos de empresas apagadas (órfãos)

Apagar uma empresa leva `media_files` junto (cascata), mas os OBJETOS continuam no bucket sob `org/<id da empresa>/`. Para achar e limpar:

```bash
# lista empresas com arquivos no bucket que não existem mais (só ids e contagens)
pnpm --filter @duckzap/api media:orphans

# mostra quantos objetos e MB seriam apagados (não apaga)
pnpm --filter @duckzap/api media:orphans --purge org_abc123

# apaga de verdade (recusa se a empresa ainda existe)
pnpm --filter @duckzap/api media:orphans --purge org_abc123 --yes
```

O script lê `MEDIA_STORAGE_*` e `DATABASE_URL` do `apps/api/.env`. Faça isto depois de confirmar a exclusão da empresa (a LGPD manda apagar os arquivos junto). Sem o script, com `rclone`: `rclone purge r2:<bucket>/org/<id>/`.

## 3. Exclusão de um contato (LGPD)

Já é automática: excluir o contato apaga as mensagens e TAMBÉM os objetos e registros `media_files` das conversas dele, na mesma transação. Se o bucket estiver fora do ar a exclusão falha inteira (erro 500): tente de novo quando o armazenamento voltar. Se o armazenamento foi desconfigurado e ainda há arquivos, a exclusão também falha: reconfigure as variáveis ou limpe o prefixo da empresa antes.

## 4. Sobras do dia a dia

- Envios abandonados (`uploading` há mais de 1 h) e arquivos nunca usados em mensagem saem sozinhos, em lotes, a cada novo pedido de envio da empresa (sem job). Empresa que para de usar deixa as últimas sobras até voltar a enviar ou ser apagada.
- Registros `deleted` (arquivo recusado na conferência) são removidos depois de 7 dias.
- Para ver o que há sob uma empresa: `pnpm --filter @duckzap/api media:orphans --purge <id>` (sem `--yes` só conta).

## 5. Desenvolvimento local

`docker compose -f docker-compose.local.yml up -d minio` sobe o MinIO (API S3 em `localhost:9002`, console em `localhost:9003`; usuário e senha `duckzap` / `duckzap-dev-minio`, só para dev) e cria o bucket `duckzap-media`. O CORS vem liberado para `http://localhost:3000`. Valores de exemplo em `apps/api/.env.example`. Para que a Evolution local baixe mídia recebida, recrie só ela depois de atualizar o compose: `docker compose -f docker-compose.local.yml up -d evolution`.

Testes contra o MinIO real: `MEDIA_MINIO_INTEGRATION=1 TEST_DB_NAME=<banco descartável> ONLY_PACKAGE=api bash scripts/test-all.sh media`.

## 6. Pendências de segurança

- **Sem antivírus.** Falta varrer documentos (ClamAV ou serviço) antes de entregar ao cliente/equipe. Até lá: tipo real por magic bytes, tamanho, nome sanitizado, `Content-Type` fixo e download forçado de documentos.
- Sem expurgo por idade: a mídia fica enquanto a conversa/contato existir. Se for preciso um prazo, definir política (INSTRUCTIONS §5.5) e uma regra de ciclo de vida do bucket.
