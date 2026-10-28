import { formatMediaLimit, isAllowedMime, MEDIA_RULES, type MediaKind } from "@duckzap/contracts/media";

// Lógica PURA de mídia da conversa (imagens, documentos, áudios): validação contra MEDIA_RULES, textos de erro,
// tamanhos, rótulos por tipo e a máquina de estados do envio. Sem React nem navegador: é o que os testes cobrem.

// ── tamanhos e durações ─────────────────────────────────────────────────────

/** "812 KB", "2,4 MB", "10 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return "1 KB";
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) return `${kb} KB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, "").replace(".", ",")} MB`;
  return `${(mb / 1024).toFixed(1).replace(/\.0$/, "").replace(".", ",")} GB`;
}

/** "0:12", "1:05". */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// ── tipos aceitos ───────────────────────────────────────────────────────────

const EXTENSION_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".webm": "audio/webm",
};

const MIME_EXTENSION: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
};

/** "image/png; codecs=x" → "image/png". */
export function normalizeMime(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLowerCase();
}

/** Valor do atributo `accept` do <input type="file">: extensões + tipos do contrato. */
export function acceptAttribute(kind: MediaKind): string {
  return [...MEDIA_RULES[kind].extensions, ...MEDIA_RULES[kind].mimes].join(",");
}

const EXTENSION_LABEL: Record<string, string> = { ".webp": "WebP" };

function joinWithOu(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ou ${items[items.length - 1]}`;
}

/** "JPG, PNG ou WebP". */
export function allowedTypesLabel(kind: MediaKind): string {
  const names = MEDIA_RULES[kind].extensions.map((ext) => (ext === ".jpeg" ? ".jpg" : ext));
  const unique = [...new Set(names)].map((ext) => EXTENSION_LABEL[ext] ?? ext.slice(1).toUpperCase());
  return joinWithOu(unique);
}

/** "JPG, PNG ou WebP até 10 MB" (dica do menu de anexo e das mensagens de erro). */
export function mediaRulesHint(kind: MediaKind): string {
  return `${allowedTypesLabel(kind)} até ${formatMediaLimit(kind)}`;
}

// ── validação antes de enviar ───────────────────────────────────────────────

export type MediaProblem = "empty" | "type" | "size";

export type MediaCheck = { ok: true; mimeType: string } | { ok: false; reason: MediaProblem; message: string };

export function mediaProblemMessage(kind: MediaKind, reason: MediaProblem, sizeBytes?: number): string {
  switch (reason) {
    case "empty":
      return "Esse arquivo está vazio. Escolha outro.";
    case "type":
      return `Esse tipo de arquivo não pode ser enviado. Use ${mediaRulesHint(kind)}.`;
    case "size":
      return `Esse arquivo tem ${formatFileSize(sizeBytes ?? 0)} e o limite é ${formatMediaLimit(kind)}. Use ${mediaRulesHint(kind)}.`;
  }
}

/**
 * Confere tipo e tamanho contra `MEDIA_RULES` (a API confere de novo, pelos bytes). Devolve o mime a mandar:
 * o do navegador quando é aceito; pela extensão quando o navegador não sabe (vazio ou octet-stream).
 */
export function validateMediaFile(kind: MediaKind, file: { name: string; type: string; size: number }): MediaCheck {
  const rules = MEDIA_RULES[kind];
  const fail = (reason: MediaProblem): MediaCheck => ({ ok: false, reason, message: mediaProblemMessage(kind, reason, file.size) });

  if (file.size <= 0) return fail("empty");

  const mime = normalizeMime(file.type);
  const ext = extensionOf(file.name);
  const extAllowed = (rules.extensions as readonly string[]).includes(ext);
  let mimeType: string;
  if (mime === "" || mime === "application/octet-stream") {
    const byExtension = extAllowed ? EXTENSION_MIME[ext] : undefined;
    if (!byExtension) return fail("type");
    mimeType = byExtension;
  } else if (isAllowedMime(kind, mime)) {
    // o Windows costuma marcar .csv como planilha: a extensão é mais fiel para texto
    mimeType = extAllowed && (ext === ".csv" || ext === ".txt") ? (EXTENSION_MIME[ext] ?? mime) : mime;
  } else {
    return fail("type");
  }

  if (file.size > rules.maxBytes) return fail("size");
  return { ok: true, mimeType };
}

// ── rótulos por tipo ────────────────────────────────────────────────────────

export type FileLabel = { label: string; short: string };

/** Nome humano e sigla curta (para o ícone) de um arquivo. */
export function describeFile(mimeType: string, fileName: string | null): FileLabel {
  const mime = normalizeMime(mimeType);
  if (mime.startsWith("image/")) return { label: "Imagem", short: "IMG" };
  if (mime.startsWith("audio/")) return { label: "Áudio", short: "ÁUD" };
  if (mime === "application/pdf") return { label: "PDF", short: "PDF" };
  if (mime === "application/msword" || mime.includes("wordprocessingml")) return { label: "Word", short: "DOC" };
  if (mime === "application/vnd.ms-excel" || mime.includes("spreadsheetml")) {
    return extensionOf(fileName ?? "") === ".csv" ? { label: "CSV", short: "CSV" } : { label: "Planilha", short: "XLS" };
  }
  if (mime === "application/vnd.ms-powerpoint" || mime.includes("presentationml")) return { label: "Apresentação", short: "PPT" };
  if (mime === "text/csv") return { label: "CSV", short: "CSV" };
  if (mime === "text/plain") return { label: "Texto", short: "TXT" };
  const ext = extensionOf(fileName ?? "").slice(1).toUpperCase();
  return { label: ext || "Arquivo", short: ext.slice(0, 4) || "ARQ" };
}

/** Prévia de "última mensagem" para mídia: "📷 Imagem", "📄 nome.pdf", "🎤 Áudio 0:12". */
export function mediaPreviewLabel(input: {
  kind: "image" | "document" | "audio";
  fileName: string | null;
  durationSeconds: number | null;
  caption?: string | null;
}): string {
  switch (input.kind) {
    case "image":
      return `📷 ${input.caption?.trim() || "Imagem"}`;
    case "document":
      return `📄 ${input.fileName?.trim() || "Documento"}`;
    case "audio":
      return `🎤 Áudio${input.durationSeconds ? ` ${formatDuration(input.durationSeconds)}` : ""}`;
  }
}

/** "PDF · 2,4 MB": descrição do arquivo escolhido ou recebido. */
export function describeAttachment(att: { mimeType: string; fileName: string | null; sizeBytes: number | null; durationSeconds?: number | null }): string {
  const parts = [describeFile(att.mimeType, att.fileName).label];
  if (att.durationSeconds) parts.push(formatDuration(att.durationSeconds));
  if (att.sizeBytes) parts.push(formatFileSize(att.sizeBytes));
  return parts.join(" · ");
}

// ── gravação de áudio ───────────────────────────────────────────────────────

const RECORDER_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"] as const;

/** Primeiro formato de gravação que o navegador sabe produzir (e que o contrato aceita). `null` = deixa o navegador escolher. */
export function pickRecorderMime(isSupported: (mimeType: string) => boolean): string | null {
  return RECORDER_MIMES.find((m) => isSupported(m)) ?? null;
}

export function recordedFileName(mimeType: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return `audio-${stamp}${MIME_EXTENSION[normalizeMime(mimeType)] ?? ".webm"}`;
}

/** Motivo da falha ao abrir o microfone (nome do DOMException, ou "unsupported") → texto para a pessoa. */
export function micErrorMessage(errorName: string): string {
  switch (errorName) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "O navegador bloqueou o microfone. Libere a permissão nas configurações do site e tente de novo.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "Não encontramos um microfone neste dispositivo.";
    case "NotReadableError":
    case "TrackStartError":
      return "O microfone está em uso por outro programa. Feche-o e tente de novo.";
    case "unsupported":
      return "Este navegador não permite gravar áudio. Use uma versão atual do Chrome, Edge, Firefox ou Safari.";
    default:
      return "Não deu para iniciar a gravação. Tente de novo.";
  }
}

// ── envio: máquina de estados ───────────────────────────────────────────────

/** Onde o envio falhou: define de onde o "Tentar de novo" recomeça (só `send` reaproveita o arquivo já guardado). */
export type UploadStep = "upload" | "check" | "send";

export type UploadState =
  | { phase: "idle" }
  | { phase: "chosen" }
  /** 0 = preparando (pedindo a URL); depois o progresso real do envio ao armazenamento */
  | { phase: "uploading"; percent: number }
  | { phase: "checking" }
  | { phase: "sending" }
  | { phase: "sent" }
  | { phase: "error"; step: UploadStep; message: string };

export type UploadEvent =
  | { type: "pick" }
  | { type: "start" }
  | { type: "progress"; percent: number }
  | { type: "uploaded" }
  | { type: "checked" }
  | { type: "sent" }
  | { type: "fail"; step: UploadStep; message: string }
  | { type: "retry" }
  | { type: "reset" };

export const INITIAL_UPLOAD_STATE: UploadState = { phase: "idle" };

/** Transição inválida devolve o MESMO estado (sem render à toa). */
export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case "reset":
      return state.phase === "idle" ? state : INITIAL_UPLOAD_STATE;
    case "pick":
      return state.phase === "idle" || state.phase === "chosen" || state.phase === "error" || state.phase === "sent"
        ? { phase: "chosen" }
        : state;
    case "start":
      return state.phase === "chosen" ? { phase: "uploading", percent: 0 } : state;
    case "retry":
      if (state.phase !== "error") return state;
      return state.step === "send" ? { phase: "sending" } : { phase: "uploading", percent: 0 };
    case "progress": {
      if (state.phase !== "uploading") return state;
      const percent = Math.max(state.percent, Math.min(100, Math.max(0, Math.round(event.percent))));
      return percent === state.percent ? state : { phase: "uploading", percent };
    }
    case "uploaded":
      return state.phase === "uploading" ? { phase: "checking" } : state;
    case "checked":
      return state.phase === "checking" ? { phase: "sending" } : state;
    case "sent":
      return state.phase === "sending" ? { phase: "sent" } : state;
    case "fail":
      return isUploadBusy(state) ? { phase: "error", step: event.step, message: event.message } : state;
  }
}

/** Em andamento: não dá para trocar o arquivo nem enviar de novo. */
export function isUploadBusy(state: UploadState): boolean {
  return state.phase === "uploading" || state.phase === "checking" || state.phase === "sending";
}

/** Só o envio ao armazenamento pode ser interrompido; depois disso a API já está trabalhando. */
export function canCancelUpload(state: UploadState): boolean {
  return state.phase !== "checking" && state.phase !== "sending" && state.phase !== "sent" && state.phase !== "idle";
}

/** Texto para o leitor de tela e para a barra ("Enviando o arquivo… 42%"). */
export function uploadStatusText(state: UploadState): string {
  switch (state.phase) {
    case "idle":
    case "chosen":
      return "";
    case "uploading":
      return state.percent <= 0 ? "Preparando o envio…" : `Enviando o arquivo… ${state.percent}%`;
    case "checking":
      return "Conferindo o arquivo…";
    case "sending":
      return "Enviando a mensagem…";
    case "sent":
      return "Enviado.";
    case "error":
      return state.message;
  }
}

/** Progresso para a barra: 0–100 enquanto envia; confere/envia já contam como completo. */
export function uploadProgressValue(state: UploadState): number {
  if (state.phase === "uploading") return state.percent;
  return state.phase === "checking" || state.phase === "sending" || state.phase === "sent" ? 100 : 0;
}

export const UPLOAD_NETWORK_ERROR = "Não foi possível enviar o arquivo. Tente de novo.";

/** Falha do PUT direto ao armazenamento. Nunca inclui a URL assinada. `status` null = rede/CORS. */
export function putFailureMessage(status: number | null): string {
  return status === 401 || status === 403 ? "O tempo para enviar o arquivo acabou. Tente de novo." : UPLOAD_NETWORK_ERROR;
}
