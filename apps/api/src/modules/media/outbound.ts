import type { Transaction } from "@duckzap/db";
import { MEDIA_RULES } from "@duckzap/contracts/media";
import { isSafeMediaUrlResolved } from "../channels/security";
import type { MessagingProvider, OutboundMessage } from "../../lib/messaging";
import { FILE_TYPES, MEDIA_UNAVAILABLE, SIGNATURE_BYTES, extensionOf, hasSignature } from "./logic";
import { getMediaRuntime, type MediaRuntime } from "./runtime";
import { discard, findReadyMedia } from "./service";

/** Validade da URL que o provedor busca ao enviar (ele a usa na hora; o resto do tempo é folga para retentativa). */
const PROVIDER_URL_SECONDS = 900;

export type MediaOutbound = { ok: true; message: OutboundMessage; via: "url" | "base64" } | { ok: false; message: string };

/**
 * Monta a mensagem de saída com a mídia, a partir do `mediaId` (a URL do cliente nunca entra aqui).
 *
 * Como o arquivo chega ao WhatsApp (`MEDIA_SEND_MODE`):
 *   - `url`: URL assinada de leitura; o provedor baixa. Exige armazenamento https e alcançável por ele.
 *   - `base64`: a API lê o objeto e envia o conteúdo. Funciona sem URL pública (desenvolvimento). Só provedor com `mediaBase64`.
 *   - `auto` (padrão): `url` quando o armazenamento é https e a URL passa na checagem anti-SSRF; senão `base64`.
 * Provedor sem `mediaBase64` (API oficial da Meta) sempre usa URL.
 */
export async function buildMediaMessage(
  tx: Transaction,
  input: { organizationId: string; kind: "image" | "document" | "audio"; mediaId: string | null | undefined; to: string; externalId: string; caption: string },
  provider: Pick<MessagingProvider, "capabilities"> | undefined,
  rt: MediaRuntime = getMediaRuntime(),
): Promise<MediaOutbound> {
  if (!rt.storage) return { ok: false, message: MEDIA_UNAVAILABLE };
  if (!input.mediaId) return { ok: false, message: "Este anexo não pode ser reenviado. Anexe o arquivo de novo." };
  const row = await findReadyMedia(tx, input.organizationId, input.mediaId);
  if (!row || row.kind !== input.kind) return { ok: false, message: "O arquivo deste anexo não está mais disponível. Anexe de novo." };

  const base = {
    externalId: input.externalId,
    to: input.to,
    kind: input.kind,
    filename: row.fileName,
    ...(input.caption && input.kind !== "audio" ? { text: input.caption } : {}),
  } satisfies Partial<OutboundMessage>;

  // o PUT assinado vale 10 min e o objeto pode ser trocado depois do `complete`: confere o tipo real DE NOVO na hora de enviar
  const altered = () => ({ ok: false, message: "O arquivo foi alterado depois de enviado e foi descartado. Anexe de novo." }) as const;
  const type = FILE_TYPES[extensionOf(row.fileName)];
  const recheck = async (head: Buffer | null) => {
    if (head && type && hasSignature(type.signature, head.subarray(0, SIGNATURE_BYTES))) return true;
    await discard(tx, rt, row);
    return false;
  };

  const canBase64 = provider?.capabilities().mediaBase64 === true;
  let useBase64 = canBase64 && (rt.sendMode === "base64" || (rt.sendMode === "auto" && !rt.storageIsHttps));
  if (!useBase64) {
    let url: string;
    try {
      if (!(await recheck(await rt.storage.getRange(row.storageKey, 0, SIGNATURE_BYTES - 1)))) return altered();
      url = await rt.storage.presignGet(row.storageKey, { expiresInSeconds: PROVIDER_URL_SECONDS, contentType: row.mimeType });
    } catch {
      rt.log.warn("media.provider_url_failed", { mediaId: row.id });
      return { ok: false, message: "Não foi possível preparar o arquivo para envio. Tente de novo." };
    }
    // em `auto` uma URL que o provedor não pode buscar (host privado) cai para base64 quando o provedor aceita
    if (!(rt.sendMode === "auto" && canBase64 && !(await isSafeMediaUrlResolved(url)))) {
      return { ok: true, via: "url", message: { ...base, mediaUrl: url } };
    }
    useBase64 = true;
  }

  try {
    const bytes = await rt.storage.getObject(row.storageKey, { maxBytes: MEDIA_RULES[input.kind].maxBytes + 1024 });
    if (!bytes) return { ok: false, message: "O arquivo deste anexo não está mais disponível. Anexe de novo." };
    if (bytes.length !== row.sizeBytes || !(await recheck(bytes))) return altered();
    return { ok: true, via: "base64", message: { ...base, mediaBase64: bytes.toString("base64"), mimeType: row.mimeType } };
  } catch {
    rt.log.warn("media.read_failed", { mediaId: row.id });
    return { ok: false, message: "Não foi possível ler o arquivo para envio. Tente de novo." };
  }
}
