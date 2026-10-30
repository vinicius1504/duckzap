import type { MediaKind, MediaReady, MediaUploadInit, MediaUploadInitResult } from "@duckzap/contracts/media";
import { schema, type Transaction } from "@duckzap/db";
import { and, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { isGuid } from "../contacts/http";
import { fail, newId, ok, type Result } from "../contacts/result";
import {
  MAX_PENDING_UPLOADS,
  MEDIA_UNAVAILABLE,
  ORPHAN_AFTER_MS,
  READ_URL_SECONDS,
  SIGNATURE_BYTES,
  UPLOAD_URL_SECONDS,
  checkUpload,
  hasSignature,
  storageKeyFor,
  FILE_TYPES,
  extensionOf,
} from "./logic";
import { makeThumbnail, thumbnailKeyFor } from "../../lib/thumbnail";
import { getMediaRuntime, type MediaRuntime } from "./runtime";

const { mediaFiles, messages, conversations, productImages } = schema;

export type MediaFileRow = typeof mediaFiles.$inferSelect;
export type MediaCtx = { organizationId: string; userId: string; sendingPaused: boolean };

const kindOf = (value: string): MediaKind => (value === "image" || value === "audio" ? value : "document");

// ── envio (navegador → armazenamento) ───────────────────────────────────────

/** `POST /media/uploads`: valida o pedido, registra `uploading` e devolve a URL assinada de PUT (10 min). */
export async function createUpload(
  tx: Transaction,
  ctx: MediaCtx,
  input: MediaUploadInit,
  rt: MediaRuntime = getMediaRuntime(),
): Promise<Result<MediaUploadInitResult, "media_unavailable" | "sending_paused" | "invalid_media" | "too_many_uploads">> {
  if (!rt.storage) return fail("media_unavailable", MEDIA_UNAVAILABLE);
  if (ctx.sendingPaused) return fail("sending_paused", "Seu plano expirou. O envio fica pausado até renovar.");
  const checked = checkUpload(input);
  if (!checked.ok) return fail("invalid_media", checked.message);
  if (input.durationSeconds != null && input.kind !== "audio") return fail("invalid_media", "Só áudios têm duração.");

  const now = rt.now();
  await cleanupOrphans(tx, ctx.organizationId, rt, now);
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.organizationId, ctx.organizationId), eq(mediaFiles.status, "uploading")));
  if ((pending?.n ?? 0) >= MAX_PENDING_UPLOADS) {
    return fail("too_many_uploads", "Há arquivos demais sendo enviados ao mesmo tempo. Aguarde alguns minutos e tente de novo.");
  }

  const id = newId();
  const storageKey = storageKeyFor(ctx.organizationId, now);
  const signed = await rt.storage.presignPut(storageKey, { contentType: checked.type.mime, contentLength: input.sizeBytes, expiresInSeconds: UPLOAD_URL_SECONDS });
  await tx.insert(mediaFiles).values({
    id,
    organizationId: ctx.organizationId,
    kind: input.kind,
    fileName: checked.fileName,
    mimeType: checked.type.mime,
    sizeBytes: input.sizeBytes,
    durationSeconds: input.kind === "audio" ? (input.durationSeconds ?? null) : null,
    storageKey,
    status: "uploading",
    direction: "out",
    createdBy: ctx.userId,
    createdAt: now,
  });
  return ok({ mediaId: id, uploadUrl: signed.url, headers: signed.headers, expiresAt: new Date(now.getTime() + UPLOAD_URL_SECONDS * 1000).toISOString() });
}

/**
 * `POST /media/uploads/{id}/complete`: LÊ o objeto, confere o tamanho real e o tipo REAL pelos primeiros bytes. Arquivo que
 * não confere é apagado do armazenamento e o registro vira `deleted` (a resposta é 422 com o motivo, em português).
 * Idempotente: repetir num arquivo já `ready` devolve o mesmo resultado.
 */
export async function completeUpload(
  tx: Transaction,
  ctx: MediaCtx,
  mediaId: string,
  rt: MediaRuntime = getMediaRuntime(),
): Promise<Result<MediaReady, "media_unavailable" | "not_found" | "invalid_media" | "not_uploaded">> {
  if (!rt.storage) return fail("media_unavailable", MEDIA_UNAVAILABLE);
  if (!isGuid(mediaId)) return fail("not_found", "Arquivo não encontrado.");
  const [row] = await tx
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, mediaId), eq(mediaFiles.organizationId, ctx.organizationId), eq(mediaFiles.direction, "out")))
    .limit(1)
    .for("update");
  // só quem pediu o envio confere; arquivo de outra pessoa/empresa é "não existe"
  if (!row || row.createdBy !== ctx.userId) return fail("not_found", "Arquivo não encontrado.");
  if (row.status === "deleted") return fail("not_found", "Este envio expirou ou foi recusado. Envie o arquivo de novo.");
  if (row.status === "ready") return ok(toReady(row));

  const head = await rt.storage.head(row.storageKey);
  if (!head) return fail("not_uploaded", "O arquivo não chegou ao armazenamento. Tente enviar de novo.");
  if (head.sizeBytes !== row.sizeBytes) {
    return reject(tx, rt, row, `O tamanho do arquivo "${row.fileName}" não confere com o informado. Envie o arquivo de novo.`);
  }
  const bytes = await rt.storage.getRange(row.storageKey, 0, Math.min(row.sizeBytes, SIGNATURE_BYTES) - 1);
  if (!bytes) return fail("not_uploaded", "O arquivo não chegou ao armazenamento. Tente enviar de novo.");
  const type = FILE_TYPES[extensionOf(row.fileName)];
  if (!type || type.kind !== row.kind || !hasSignature(type.signature, bytes)) {
    return reject(tx, rt, row, `O conteúdo de "${row.fileName}" não é ${article(type?.label ?? "do tipo informado")}. Por segurança o arquivo foi descartado: envie o arquivo original.`);
  }
  const thumbKey = row.kind === "image" ? await storeThumbnail(rt, row.storageKey, await rt.storage.getObject(row.storageKey, { maxBytes: row.sizeBytes }).catch(() => null)) : null;
  const [ready] = await tx
    .update(mediaFiles)
    .set({ status: "ready", readyAt: rt.now(), thumbKey })
    .where(and(eq(mediaFiles.id, row.id), eq(mediaFiles.status, "uploading")))
    .returning();
  return ok(toReady(ready ?? row));
}

const article = (label: string) => `${/^(imagem|planilha|apresentação)/.test(label) ? "uma" : "um"} ${label} de verdade`;

async function reject(tx: Transaction, rt: MediaRuntime, row: MediaFileRow, message: string) {
  await discard(tx, rt, row);
  return fail("invalid_media" as const, message);
}

/**
 * Reduz a imagem e guarda a miniatura ao lado da original. Melhor esforço: sem bytes, sem armazenamento ou imagem ilegível
 * devolve null (o registro fica sem `thumb_key` e o balão usa a original). Nunca lança.
 */
export async function storeThumbnail(rt: MediaRuntime, storageKey: string, bytes: Buffer | null): Promise<string | null> {
  if (!rt.storage || !bytes) return null;
  try {
    const thumb = await makeThumbnail(bytes);
    if (!thumb) return null;
    const key = thumbnailKeyFor(storageKey);
    await rt.storage.put(key, thumb, { contentType: "image/webp" });
    return key;
  } catch {
    rt.log.warn("media.thumbnail_failed", { storageKey });
    return null;
  }
}

/** Chaves dos objetos de um arquivo (a original e, se houver, a miniatura). */
const objectKeys = (row: { storageKey: string; thumbKey?: string | null }) => (row.thumbKey ? [row.storageKey, row.thumbKey] : [row.storageKey]);

/** Apaga o objeto (melhor esforço) e marca o registro como `deleted`. */
export async function discard(tx: Transaction, rt: MediaRuntime, row: Pick<MediaFileRow, "id" | "storageKey"> & { thumbKey?: string | null }) {
  try {
    await rt.storage?.deleteMany(objectKeys(row));
  } catch {
    rt.log.error("media.discard_failed", { mediaId: row.id });
  }
  await tx.update(mediaFiles).set({ status: "deleted", readyAt: null }).where(eq(mediaFiles.id, row.id));
}

function toReady(row: MediaFileRow): MediaReady {
  return { mediaId: row.id, kind: kindOf(row.kind), fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes, durationSeconds: row.durationSeconds };
}

// ── limpeza oportunista ─────────────────────────────────────────────────────

const ORPHAN_BATCH = 25;
const DELETED_RECORD_DAYS = 7;

/**
 * Sem job novo: a cada envio da empresa apaga um lote de sobras. Órfãos: `uploading` há mais de 1 h; `ready` que nunca foi
 * para uma mensagem (recebido há mais de 1 h; enviado há mais de 24 h); e registros `deleted` sem mensagem com mais de 7
 * dias. Fotos de produto (`product_images`) ficam de fora. Nunca falha o pedido que a chamou.
 */
export async function cleanupOrphans(tx: Transaction, organizationId: string, rt: MediaRuntime = getMediaRuntime(), now = rt.now()): Promise<number> {
  if (!rt.storage) return 0;
  try {
    const hour = new Date(now.getTime() - ORPHAN_AFTER_MS);
    const day = new Date(now.getTime() - 24 * 3_600_000);
    const old = new Date(now.getTime() - DELETED_RECORD_DAYS * 86_400_000);
    const rows = await tx
      .select({ id: mediaFiles.id, storageKey: mediaFiles.storageKey, thumbKey: mediaFiles.thumbKey, status: mediaFiles.status })
      .from(mediaFiles)
      .where(
        and(
          eq(mediaFiles.organizationId, organizationId),
          // foto de produto do catálogo nunca é órfã: enquanto `product_images` a referencia, ninguém a apaga
          notExists(tx.select({ one: sql`1` }).from(productImages).where(eq(productImages.mediaId, mediaFiles.id))),
          or(
            and(eq(mediaFiles.status, "uploading"), lt(mediaFiles.createdAt, hour)),
            and(eq(mediaFiles.status, "ready"), isNull(mediaFiles.messageId), or(and(eq(mediaFiles.direction, "in"), lt(mediaFiles.createdAt, hour)), and(eq(mediaFiles.direction, "out"), lt(mediaFiles.createdAt, day)))),
            and(eq(mediaFiles.status, "deleted"), isNull(mediaFiles.messageId), lt(mediaFiles.createdAt, old)),
          ),
        ),
      )
      .limit(ORPHAN_BATCH);
    if (rows.length === 0) return 0;
    const keys = rows.filter((r) => r.status !== "deleted").flatMap(objectKeys);
    if (keys.length) await rt.storage.deleteMany(keys);
    await tx.delete(mediaFiles).where(inArray(mediaFiles.id, rows.map((r) => r.id)));
    return rows.length;
  } catch {
    rt.log.warn("media.cleanup_failed", { organizationId });
    return 0;
  }
}

// ── uso numa mensagem ───────────────────────────────────────────────────────

/**
 * Reserva o arquivo para uma mensagem de saída: precisa existir NA empresa, ser da própria pessoa que o enviou, estar `ready`,
 * ser do mesmo tipo de mídia e ainda não ter sido usado. Trava a linha (`FOR UPDATE`): dois envios do mesmo `mediaId` ao mesmo tempo não passam juntos.
 */
export async function claimForSend(tx: Transaction, organizationId: string, userId: string, mediaId: string | null | undefined, kind: MediaKind): Promise<Result<MediaFileRow, "invalid_media">> {
  const invalid = (message: string) => fail("invalid_media" as const, message);
  if (!mediaId || !isGuid(mediaId)) return invalid("Anexe um arquivo enviado pelo DuckChat para continuar.");
  const [row] = await tx
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, mediaId), eq(mediaFiles.organizationId, organizationId), eq(mediaFiles.direction, "out")))
    .limit(1)
    .for("update");
  // só quem enviou o arquivo o usa numa mensagem
  if (!row || row.createdBy !== userId) return invalid("Arquivo não encontrado. Anexe o arquivo de novo.");
  if (row.status !== "ready") return invalid("O arquivo ainda não foi conferido ou foi descartado. Anexe de novo.");
  if (row.kind !== kind) return invalid("O arquivo anexado não é do tipo da mensagem.");
  if (row.messageId) return invalid("Este arquivo já foi usado em outra mensagem. Anexe de novo.");
  return ok(row);
}

export async function linkToMessage(tx: Transaction, mediaId: string, messageId: string) {
  await tx.update(mediaFiles).set({ messageId }).where(eq(mediaFiles.id, mediaId));
}

/** Arquivo `ready` da mensagem (reenvio e leitura). */
export async function findReadyMedia(tx: Transaction, organizationId: string, mediaId: string): Promise<MediaFileRow | undefined> {
  if (!isGuid(mediaId)) return undefined;
  const [row] = await tx
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, mediaId), eq(mediaFiles.organizationId, organizationId), eq(mediaFiles.status, "ready")))
    .limit(1);
  return row;
}

// ── leitura (URL assinada curta) ────────────────────────────────────────────

export type SignedMedia = { mediaId: string; url: string | null; thumbnailUrl?: string | null };

/**
 * `messageId → { mediaId, url }` dos arquivos das mensagens. A URL é assinada, vale ~10 min e SÓ sai para quem já passou
 * pela checagem de visibilidade da conversa (os ids vêm das mensagens que a pessoa pode ler). Sem armazenamento, falha ao
 * assinar ou arquivo apagado: `url: null`.
 */
export async function signMessageMedia(tx: Transaction, organizationId: string, messageIds: readonly string[], rt: MediaRuntime = getMediaRuntime()): Promise<Map<string, SignedMedia>> {
  const out = new Map<string, SignedMedia>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.organizationId, organizationId), inArray(mediaFiles.messageId, [...new Set(messageIds)])));
  for (const row of rows) {
    if (!row.messageId) continue;
    if (row.status !== "ready" || !rt.storage) {
      out.set(row.messageId, { mediaId: row.id, url: null });
      continue;
    }
    try {
      const url = await rt.storage.presignGet(row.storageKey, {
        expiresInSeconds: READ_URL_SECONDS,
        contentType: row.mimeType,
        fileName: row.fileName,
        // documentos baixam; imagem e áudio abrem na própria tela
        attachment: row.kind === "document",
      });
      // miniatura (só imagem que a tem): é o que o balão carrega; a original só abre no clique
      const thumbnailUrl = row.thumbKey
        ? await rt.storage.presignGet(row.thumbKey, { expiresInSeconds: READ_URL_SECONDS, contentType: "image/webp" }).catch(() => null)
        : null;
      out.set(row.messageId, { mediaId: row.id, url, thumbnailUrl });
    } catch {
      rt.log.warn("media.sign_failed", { mediaId: row.id });
      out.set(row.messageId, { mediaId: row.id, url: null });
    }
  }
  return out;
}

// ── LGPD ────────────────────────────────────────────────────────────────────

/**
 * Apaga objetos e registros dos arquivos das conversas dos contatos (exclusão do titular). Roda ANTES de o contato sumir, na
 * mesma transação: se o armazenamento recusar o apagamento a exclusão inteira falha (nada fica pela metade).
 * Sem armazenamento configurado e com arquivos guardados: falha também (configure ou limpe por prefixo; ver runbook).
 */
export async function eraseMediaForContacts(tx: Transaction, organizationId: string, contactIds: string[], rt: MediaRuntime = getMediaRuntime()): Promise<number> {
  if (contactIds.length === 0) return 0;
  const convIds = tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.organizationId, organizationId), inArray(conversations.contactId, contactIds)));
  const msgIds = tx.select({ id: messages.id }).from(messages).where(and(eq(messages.organizationId, organizationId), inArray(messages.conversationId, convIds)));
  const rows = await tx
    .select({ id: mediaFiles.id, storageKey: mediaFiles.storageKey, thumbKey: mediaFiles.thumbKey, status: mediaFiles.status })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.organizationId, organizationId), inArray(mediaFiles.messageId, msgIds)));
  if (rows.length === 0) return 0;
  const keys = rows.filter((r) => r.status !== "deleted").flatMap(objectKeys);
  if (keys.length > 0) {
    if (!rt.storage) throw new Error("Não foi possível apagar os arquivos das conversas: o armazenamento de mídia não está configurado.");
    await rt.storage.deleteMany(keys);
  }
  await tx.delete(mediaFiles).where(inArray(mediaFiles.id, rows.map((r) => r.id)));
  return rows.length;
}
