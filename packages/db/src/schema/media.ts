import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { messages } from "./conversations";

// Ids de linha: UUID v7 gerado pela aplicação (o pacote db não depende de `uuid`; veja platform.ts).

/**
 * Arquivos de conversa (imagem, documento, áudio) guardados no armazenamento S3-compatível (R2 em produção, MinIO no
 * desenvolvimento). O banco só guarda o registro; o conteúdo fica no objeto `storage_key`. Contrato: packages/contracts/src/media.ts.
 *
 * `uploading` = URL de envio emitida, arquivo ainda não conferido (órfãos > 1 h são apagados); `ready` = tipo real e
 * tamanho conferidos, pode ir numa mensagem (ou veio do provedor); `deleted` = objeto apagado, só o registro resta.
 * `message_id` null = ainda não usado numa mensagem. A chave NUNCA contém o nome original do arquivo.
 */
export const mediaFiles = pgTable(
  "media_files",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    /** image | document | audio */
    kind: text().notNull(),
    /** Nome sanitizado (sem caminho nem caracteres de controle). */
    fileName: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: "number" }).notNull(),
    durationSeconds: integer(),
    /** `org/<orgId>/<ano-mes>/<uuid>`: único no bucket inteiro. */
    storageKey: text().notNull(),
    /** uploading | ready | deleted */
    status: text().notNull().default("uploading"),
    /** out = enviado pela equipe; in = recebido do cliente */
    direction: text().notNull(),
    /** Id de quem enviou (usuário); null quando veio do cliente. */
    createdBy: text(),
    /** Mensagem que usa o arquivo; null = ainda solta (ou a mensagem foi apagada). */
    messageId: uuid().references(() => messages.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("media_files_storage_key_key").on(t.storageKey),
    // limpeza dos `uploading` órfãos e contagem de envios em andamento da empresa
    index("media_files_org_status_created_idx").on(t.organizationId, t.status, t.createdAt),
    // arquivos de uma mensagem (leitura da conversa e exclusão do contato)
    index("media_files_message_idx").on(t.messageId),
    check("media_files_kind_check", sql`${t.kind} in ('image','document','audio')`),
    check("media_files_status_check", sql`${t.status} in ('uploading','ready','deleted')`),
    check("media_files_direction_check", sql`${t.direction} in ('out','in')`),
    tenantPolicy("media_files", t.organizationId),
  ],
).enableRLS();
