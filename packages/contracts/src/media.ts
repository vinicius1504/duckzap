import { z } from "zod";

/**
 * Mídia de conversa (imagens, documentos e áudios que a equipe envia e que o cliente manda).
 *
 * Fluxo de ENVIO (o navegador nunca recebe credencial do armazenamento):
 *   1. `POST /v1/media/uploads` com `mediaUploadInit` → a API valida tipo/tamanho e devolve uma URL assinada de envio (PUT);
 *   2. o navegador envia o arquivo direto ao armazenamento (S3-compatível: Cloudflare R2 em produção, MinIO no desenvolvimento);
 *   3. `POST /v1/media/uploads/{mediaId}/complete` → a API LÊ o arquivo, confere o tipo REAL pelos primeiros bytes (magic bytes) e o
 *      tamanho; se não bater, apaga e recusa. Só então o `mediaId` pode ir numa mensagem;
 *   4. `POST /v1/conversations/{id}/messages` com `attachment.mediaId` (a URL que o cliente mandar é ignorada).
 * Mídia RECEBIDA é baixada do provedor e guardada do mesmo jeito. Nas leituras, `attachment.url` é uma URL assinada CURTA (minutos);
 * nada é público.
 */

export const MEDIA_KINDS = ["image", "document", "audio"] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

const MB = 1024 * 1024;

/**
 * O que a empresa pode enviar. Fonte única: a tela mostra estes limites, a API valida de verdade.
 * Os limites vêm do que o WhatsApp aceita com folga (imagem até ~16 MB, documento até 100 MB, áudio até ~16 MB); ficamos abaixo
 * para o envio não falhar no meio. Mudar aqui muda o app todo.
 */
export const MEDIA_RULES = {
  image: {
    label: "Imagem",
    mimes: ["image/jpeg", "image/png", "image/webp"],
    extensions: [".jpg", ".jpeg", ".png", ".webp"],
    maxBytes: 10 * MB,
  },
  document: {
    label: "Documento",
    mimes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "text/plain",
      "text/csv",
    ],
    extensions: [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv"],
    maxBytes: 20 * MB,
  },
  audio: {
    label: "Áudio",
    mimes: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm"],
    extensions: [".ogg", ".opus", ".mp3", ".m4a", ".webm"],
    maxBytes: 16 * MB,
  },
} as const satisfies Record<MediaKind, { label: string; mimes: readonly string[]; extensions: readonly string[]; maxBytes: number }>;

export function maxMediaBytes(kind: MediaKind) {
  return MEDIA_RULES[kind].maxBytes;
}

export function isAllowedMime(kind: MediaKind, mimeType: string): boolean {
  return (MEDIA_RULES[kind].mimes as readonly string[]).includes(mimeType.split(";")[0]?.trim().toLowerCase() ?? "");
}

/** "10 MB", "20 MB" para a tela. */
export function formatMediaLimit(kind: MediaKind): string {
  return `${Math.round(MEDIA_RULES[kind].maxBytes / MB)} MB`;
}

export const mediaUploadInitSchema = z.object({
  kind: mediaKindSchema,
  fileName: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(3).max(120),
  sizeBytes: z.number().int().positive(),
  /** só áudio gravado no navegador: duração em segundos */
  durationSeconds: z.number().int().min(0).max(60 * 60).nullable().optional(),
});
export type MediaUploadInit = z.infer<typeof mediaUploadInitSchema>;

export const mediaUploadInitResultSchema = z.object({
  mediaId: z.string(),
  /** URL assinada para o navegador fazer PUT do arquivo (expira em poucos minutos) */
  uploadUrl: z.string(),
  /** cabeçalhos que o PUT deve levar (ex.: Content-Type) */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});
export type MediaUploadInitResult = z.infer<typeof mediaUploadInitResultSchema>;

/** Resposta do `complete`: o arquivo foi conferido e pode ir numa mensagem. */
export const mediaReadySchema = z.object({
  mediaId: z.string(),
  kind: mediaKindSchema,
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  durationSeconds: z.number().int().nullable(),
});
export type MediaReady = z.infer<typeof mediaReadySchema>;
