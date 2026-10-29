import { schema, withOrg, type Database } from "@duckzap/db";
import { and, eq } from "drizzle-orm";
import type { InboundContext } from "../../lib/inbound";
import { ProviderError, type InboundEvent } from "../../lib/messaging";
import { findChannel, buildRef } from "../channels/repo";
import { getChannelsRuntime, type ChannelsRuntime } from "../channels/runtime";
import { newId } from "../contacts/result";
import { MAX_INBOUND_BYTES, SIGNATURE_BYTES, hasSignature, resolveInboundType, storageKeyFor } from "./logic";
import { getMediaRuntime, type MediaRuntime } from "./runtime";
import { cleanupOrphans, storeThumbnail } from "./service";

const { mediaFiles, messages } = schema;

/** Tempo máximo (ms) esperando o provedor entregar o arquivo. Passou disso, a mensagem entra com anexo "indisponível". */
export const INBOUND_DOWNLOAD_TIMEOUT_MS = 20_000;

export type StoredInboundMedia = { id: string; fileName: string; mimeType: string; sizeBytes: number };

/**
 * Resultado de preparar a mídia de uma mensagem recebida:
 *   none         não é mídia (ou a mensagem já existe: webhook repetido, nada a baixar);
 *   stored       baixada, conferida e guardada (`media_files` `ready`, ainda sem mensagem);
 *   unavailable  não deu para baixar/guardar (sem armazenamento, provedor sem suporte, falha de rede): a mensagem entra com o anexo `url: null`;
 *   unsupported  tipo fora de `MEDIA_RULES` ou conteúdo que não bate com o tipo: NÃO é guardada.
 */
export type PreparedInboundMedia =
  | { state: "none" }
  | { state: "stored"; file: StoredInboundMedia }
  | { state: "unavailable" }
  | { state: "unsupported" };

export type InboundMediaPort = {
  /** Nunca lança: qualquer falha vira `unavailable`. Roda FORA da transação da mensagem (não segura lock da conversa). */
  prepare(db: Database, context: InboundContext, event: Extract<InboundEvent, { type: "message" }>): Promise<PreparedInboundMedia>;
  /** A mensagem não foi gravada (duplicada, contato inválido…): apaga o arquivo recém-guardado. Melhor esforço. */
  discard(db: Database, organizationId: string, file: StoredInboundMedia): Promise<void>;
};

type Options = {
  channels?: () => Pick<ChannelsRuntime, "providers" | "config" | "log">;
  media?: () => MediaRuntime;
  downloadTimeoutMs?: number;
};

export function createInboundMediaPort(options: Options = {}): InboundMediaPort {
  const channelsRt = options.channels ?? getChannelsRuntime;
  const mediaRt = options.media ?? getMediaRuntime;
  const timeoutMs = options.downloadTimeoutMs ?? INBOUND_DOWNLOAD_TIMEOUT_MS;

  return {
    async prepare(db, context, event) {
      if (event.kind !== "image" && event.kind !== "audio" && event.kind !== "document") return { state: "none" };
      const kind = event.kind;
      const rt = mediaRt();
      const channels = channelsRt();
      const { organizationId } = context;
      try {
        // 1. canal e idempotência (transação curta): mensagem que já existe não baixa o arquivo de novo
        const info = await withOrg(db, organizationId, async (tx) => {
          const channel = await findChannel(tx, organizationId, context.channelId);
          if (!channel) return null;
          const [dup] = await tx
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.channelId, channel.id), eq(messages.externalId, event.externalId)))
            .limit(1);
          if (dup) return { duplicate: true as const };
          return { duplicate: false as const, provider: channel.provider, ref: buildRef(channel, channels) };
        });
        if (!info || info.duplicate) return { state: "none" };
        if (!rt.storage) return { state: "unavailable" };
        const provider = channels.providers.get(info.provider);
        if (!provider?.downloadMedia || !event.mediaRef) return { state: "unavailable" };

        // 2. baixa do provedor (fora de qualquer transação, com prazo curto)
        let downloaded;
        try {
          downloaded = await provider.downloadMedia(info.ref, { externalId: event.mediaRef, maxBytes: MAX_INBOUND_BYTES, timeoutMs });
        } catch (error) {
          const code = error instanceof ProviderError ? error.code : "unknown";
          rt.log.warn("media.inbound.download_failed", { channelId: context.channelId, kind, code });
          return { state: "unavailable" };
        }

        // 3. tipo e tamanho: só o que `MEDIA_RULES` aceita, e o conteúdo precisa ser mesmo daquele tipo
        const resolved = resolveInboundType(kind, downloaded.mimeType, downloaded.fileName);
        const bytes = downloaded.bytes;
        if (!resolved || bytes.length === 0 || bytes.length > MAX_INBOUND_BYTES || !hasSignature(resolved.type.signature, bytes.subarray(0, SIGNATURE_BYTES))) {
          rt.log.warn("media.inbound.unsupported", { channelId: context.channelId, kind });
          return { state: "unsupported" };
        }

        // 4. guarda o objeto e registra
        const now = rt.now();
        const file: StoredInboundMedia = { id: newId(), fileName: resolved.fileName, mimeType: resolved.type.mime, sizeBytes: bytes.length };
        const storageKey = storageKeyFor(organizationId, now);
        try {
          await rt.storage.put(storageKey, bytes, { contentType: resolved.type.mime });
        } catch {
          rt.log.warn("media.inbound.store_failed", { channelId: context.channelId, kind });
          return { state: "unavailable" };
        }
        // miniatura da imagem (melhor esforço; sem ela o balão usa a original)
        const thumbKey = kind === "image" && !event.sticker ? await storeThumbnail(rt, storageKey, bytes) : null;
        try {
          await withOrg(db, organizationId, async (tx) => {
            await tx.insert(mediaFiles).values({
              id: file.id,
              organizationId,
              kind,
              fileName: file.fileName,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              storageKey,
              thumbKey,
              status: "ready",
              direction: "in",
              createdBy: null,
              createdAt: now,
              readyAt: now,
            });
            // sobras (de quedas entre guardar e gravar a mensagem) saem aqui, sem job novo
            await cleanupOrphans(tx, organizationId, rt, now);
          });
        } catch {
          rt.log.warn("media.inbound.record_failed", { channelId: context.channelId, kind });
          await rt.storage.deleteMany(thumbKey ? [storageKey, thumbKey] : [storageKey]).catch(() => {});
          return { state: "unavailable" };
        }
        return { state: "stored", file };
      } catch {
        rt.log.warn("media.inbound.failed", { channelId: context.channelId, kind });
        return { state: "unavailable" };
      }
    },

    async discard(db, organizationId, file) {
      const rt = mediaRt();
      try {
        const [row] = await withOrg(db, organizationId, (tx) => tx.delete(mediaFiles).where(and(eq(mediaFiles.id, file.id), eq(mediaFiles.organizationId, organizationId))).returning({ key: mediaFiles.storageKey, thumbKey: mediaFiles.thumbKey }));
        if (row) await rt.storage?.deleteMany(row.thumbKey ? [row.key, row.thumbKey] : [row.key]);
      } catch {
        rt.log.warn("media.inbound.discard_failed", { mediaId: file.id });
      }
    },
  };
}
