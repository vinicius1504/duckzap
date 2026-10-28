import { MEDIA_RULES, type MediaKind } from "@duckzap/contracts/media";
import { randomUUID } from "node:crypto";

// Regras puras da mídia de conversa (sem banco nem rede): nome, tipo real (magic bytes), chave do objeto.

export const MEDIA_UNAVAILABLE = "O envio de arquivos ainda não está disponível: o armazenamento de mídia não foi configurado.";

/** Mídia recebida do cliente: acima disso o arquivo não é baixado nem guardado. */
export const MAX_INBOUND_BYTES = 25 * 1024 * 1024;
/** Quantos bytes iniciais a conferência de tipo lê (cabe qualquer assinatura e dá amostra de texto). */
export const SIGNATURE_BYTES = 8192;
/** Validade das URLs assinadas: envio (PUT) e leitura (GET). */
export const UPLOAD_URL_SECONDS = 600;
export const READ_URL_SECONDS = 600;
/** `uploading` mais velho que isto é órfão (o navegador desistiu): objeto e registro são apagados. */
export const ORPHAN_AFTER_MS = 60 * 60 * 1000;
/** Envios em andamento por empresa (anti-abuso do armazenamento). */
export const MAX_PENDING_UPLOADS = 50;

// ── nome do arquivo ─────────────────────────────────────────────────────────

// controle, separadores de linha e marcas de direção (U+202E "gpj.exe" invertido) não entram em nome nenhum
const INVISIBLE = new RegExp("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]", "g");

/** Nome seguro para guardar e mostrar: só o último trecho do caminho, sem controle, ≤ 200 caracteres (a extensão é preservada). */
export function sanitizeFileName(raw: string, maxLength = 200): string {
  let name = raw.normalize("NFC").replace(INVISIBLE, "");
  name = name.split(/[\\/]/).pop() ?? "";
  // caracteres que quebram caminho/URL/cabeçalho em algum sistema
  name = name.replace(/[<>:"|?*]/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (name.length > maxLength) {
    const ext = extensionOf(name);
    const keep = Math.max(1, maxLength - ext.length);
    name = `${Array.from(name.slice(0, name.length - ext.length)).slice(0, keep).join("")}${ext}`.slice(0, maxLength);
  }
  return name;
}

/** ".pdf" (minúsculo, com ponto) ou "" se não há extensão. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  const ext = fileName.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

// ── tipos aceitos ───────────────────────────────────────────────────────────

export type Signature = "jpeg" | "png" | "webp" | "pdf" | "zip" | "ole" | "ogg" | "mp3" | "mp4" | "webm" | "text";

export type FileType = {
  kind: MediaKind;
  /** Tipo canônico que guardamos e servimos. */
  mime: string;
  /** Outros tipos que navegadores/WhatsApp declaram para a mesma extensão. */
  aliases: readonly string[];
  signature: Signature;
  /** Nome do tipo para a mensagem de erro. */
  label: string;
};

const OOXML = (label: string, mime: string): FileType => ({ kind: "document", mime, aliases: [], signature: "zip", label });

/** Extensão → tipo. Toda extensão de `MEDIA_RULES` precisa ter uma entrada aqui (há teste de cobertura). */
export const FILE_TYPES: Readonly<Record<string, FileType>> = {
  ".jpg": { kind: "image", mime: "image/jpeg", aliases: [], signature: "jpeg", label: "imagem JPEG" },
  ".jpeg": { kind: "image", mime: "image/jpeg", aliases: [], signature: "jpeg", label: "imagem JPEG" },
  ".png": { kind: "image", mime: "image/png", aliases: [], signature: "png", label: "imagem PNG" },
  ".webp": { kind: "image", mime: "image/webp", aliases: [], signature: "webp", label: "imagem WebP" },
  ".pdf": { kind: "document", mime: "application/pdf", aliases: [], signature: "pdf", label: "PDF" },
  ".doc": { kind: "document", mime: "application/msword", aliases: [], signature: "ole", label: "documento do Word" },
  ".docx": OOXML("documento do Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  ".xls": { kind: "document", mime: "application/vnd.ms-excel", aliases: [], signature: "ole", label: "planilha do Excel" },
  ".xlsx": OOXML("planilha do Excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  ".ppt": { kind: "document", mime: "application/vnd.ms-powerpoint", aliases: [], signature: "ole", label: "apresentação do PowerPoint" },
  ".pptx": OOXML("apresentação do PowerPoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
  ".txt": { kind: "document", mime: "text/plain", aliases: [], signature: "text", label: "arquivo de texto" },
  // o Windows com Excel instalado declara .csv como application/vnd.ms-excel
  ".csv": { kind: "document", mime: "text/csv", aliases: ["application/vnd.ms-excel"], signature: "text", label: "arquivo CSV" },
  ".ogg": { kind: "audio", mime: "audio/ogg", aliases: [], signature: "ogg", label: "áudio OGG" },
  ".opus": { kind: "audio", mime: "audio/ogg", aliases: [], signature: "ogg", label: "áudio OGG/Opus" },
  ".mp3": { kind: "audio", mime: "audio/mpeg", aliases: [], signature: "mp3", label: "áudio MP3" },
  ".m4a": { kind: "audio", mime: "audio/mp4", aliases: [], signature: "mp4", label: "áudio M4A" },
  ".webm": { kind: "audio", mime: "audio/webm", aliases: [], signature: "webm", label: "áudio WebM" },
};

export const bareMime = (mime: string) => mime.split(";")[0]?.trim().toLowerCase() ?? "";

export type UploadCheck = { ok: true; fileName: string; type: FileType; ext: string } | { ok: false; message: string };

/** Valida o pedido de envio: extensão permitida para o tipo de mídia, tipo declarado coerente com a extensão, tamanho. */
export function checkUpload(input: { kind: MediaKind; fileName: string; mimeType: string; sizeBytes: number }): UploadCheck {
  const rules = MEDIA_RULES[input.kind];
  const fileName = sanitizeFileName(input.fileName);
  const ext = extensionOf(fileName);
  const allowedExt = (rules.extensions as readonly string[]).includes(ext);
  const type = FILE_TYPES[ext];
  if (!fileName || !allowedExt || !type || type.kind !== input.kind) {
    return { ok: false, message: `Arquivo não aceito: ${rules.label.toLowerCase()} precisa terminar em ${rules.extensions.join(", ")}.` };
  }
  const declared = bareMime(input.mimeType);
  if (!(rules.mimes as readonly string[]).includes(declared) || (declared !== type.mime && !type.aliases.includes(declared))) {
    return { ok: false, message: `O tipo do arquivo (${declared || "desconhecido"}) não combina com a extensão ${ext}. Envie o arquivo original.` };
  }
  if (input.sizeBytes > rules.maxBytes) {
    return { ok: false, message: `O arquivo é grande demais: o limite para ${rules.label.toLowerCase()} é ${Math.round(rules.maxBytes / (1024 * 1024))} MB.` };
  }
  if (input.sizeBytes <= 0) return { ok: false, message: "O arquivo está vazio." };
  return { ok: true, fileName, type, ext };
}

/**
 * Tipo de uma mídia RECEBIDA a partir do que o provedor declara (tipo e nome). Mais tolerante que `checkUpload` (o WhatsApp
 * manda `audio/ogg; codecs=opus`, `application/octet-stream`…), mas só devolve tipos de `MEDIA_RULES`; o conteúdo ainda é
 * conferido pelos bytes. Devolve também o nome a guardar (sanitizado, com a extensão do tipo).
 */
export function resolveInboundType(kind: MediaKind, mimeType: string | undefined, rawFileName: string | undefined): { type: FileType; fileName: string } | null {
  const mime = bareMime(mimeType ?? "");
  const named = rawFileName ? sanitizeFileName(rawFileName) : "";
  const ext = extensionOf(named);
  const candidates = Object.entries(FILE_TYPES).filter(([e, t]) => t.kind === kind && (MEDIA_RULES[kind].extensions as readonly string[]).includes(e));
  const accepts = (t: FileType) => t.mime === mime || t.aliases.includes(mime);
  let hit = candidates.find(([e, t]) => e === ext && (accepts(t) || mime === "" || mime === "application/octet-stream"));
  hit ??= candidates.find(([, t]) => accepts(t));
  if (!hit) return null;
  const [hitExt, type] = hit;
  const base = named && ext ? named.slice(0, named.length - ext.length) : named;
  const fileName = base && ext === hitExt ? named : `${base || defaultName(kind)}${hitExt}`;
  return { type, fileName: sanitizeFileName(fileName) };
}

function defaultName(kind: MediaKind) {
  return kind === "image" ? "imagem" : kind === "audio" ? "audio" : "documento";
}

// ── tipo real pelos primeiros bytes ─────────────────────────────────────────

const startsWith = (head: Buffer, bytes: readonly number[], offset = 0) => head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
const ascii = (head: Buffer, text: string, offset = 0) => startsWith(head, [...Buffer.from(text, "latin1")], offset);

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  let control = 0;
  for (const byte of head) {
    if (byte === 0) return false; // NUL: binário
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) control++;
  }
  // executável/zip/pdf renomeado para .txt ainda pode escapar do NUL em arquivos minúsculos: assinaturas conhecidas
  if (ascii(head, "MZ") || ascii(head, "\u007fELF", 0) || ascii(head, "PK\u0003\u0004") || ascii(head, "%PDF-") || startsWith(head, [0xff, 0xd8, 0xff]) || startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return false;
  return control / head.length <= 0.01;
}

/** O conteúdo começa como o tipo diz? `head` são os primeiros bytes do arquivo. */
export function hasSignature(signature: Signature, head: Buffer): boolean {
  switch (signature) {
    case "jpeg":
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case "png":
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp":
      return ascii(head, "RIFF") && ascii(head, "WEBP", 8);
    case "pdf":
      return ascii(head, "%PDF-");
    case "zip":
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]);
    case "ole":
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "ogg":
      return ascii(head, "OggS");
    case "mp3": {
      if (ascii(head, "ID3")) return true;
      // quadro MPEG: 11 bits de sincronia, versão ≠ reservada, camada III (FFFB/FFFA/FFF3/FFF2/FFE3/FFE2)
      const b1 = head[1];
      return head[0] === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0 && ((b1 >> 3) & 3) !== 1 && ((b1 >> 1) & 3) === 1;
    }
    case "mp4":
      return ascii(head, "ftyp", 4);
    case "webm":
      return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
    case "text":
      return looksLikeText(head);
  }
}

// ── chave do objeto ─────────────────────────────────────────────────────────

/** `org/<empresa>/<ano-mes>/<uuid>`. O nome original NUNCA entra na chave. */
export function storageKeyFor(organizationId: string, now: Date, id: string = randomUUID()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `org/${organizationId}/${month}/${id}`;
}

/** Prefixo de tudo o que uma empresa guarda (limpeza ao apagar a empresa). */
export const orgPrefix = (organizationId: string) => `org/${organizationId}/`;
