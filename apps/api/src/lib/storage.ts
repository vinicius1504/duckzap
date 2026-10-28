import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

/**
 * Armazenamento de objetos S3-compatível (Cloudflare R2 em produção, MinIO no desenvolvimento). O resto do app só conhece
 * `ObjectStorage`: trocar de provedor é mudar variáveis. NUNCA registre chaves de acesso nem URLs assinadas em log.
 *
 * Variáveis (todas `MEDIA_STORAGE_*`). Sem endpoint, bucket e as duas chaves o recurso fica DESLIGADO (`loadStorageConfig`
 * devolve null) e o resto da API continua funcionando.
 */

const bool = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const v = value?.trim().toLowerCase();
    if (!v) return undefined;
    if (["true", "1", "yes", "sim"].includes(v)) return true;
    if (["false", "0", "no", "nao", "não"].includes(v)) return false;
    ctx.addIssue({ code: "custom", message: 'Use "true" ou "false".' });
    return z.NEVER;
  });

const httpUrl = z.url().refine((u) => /^https?:\/\//i.test(u), "Use um endereço http:// ou https://.");

/** Como o arquivo vai ao WhatsApp: `url` (o provedor baixa de uma URL assinada), `base64` (a API lê e envia) ou `auto`. */
export const MEDIA_SEND_MODES = ["auto", "url", "base64"] as const;

export const storageEnvSchema = z.object({
  /** API S3. R2: https://<conta>.r2.cloudflarestorage.com · MinIO: http://minio:9000 */
  MEDIA_STORAGE_ENDPOINT: httpUrl.optional(),
  /** Host que o NAVEGADOR usa nas URLs assinadas quando o interno é outro (ex.: http://localhost:9002). Vazio = o mesmo. */
  MEDIA_STORAGE_PUBLIC_ENDPOINT: httpUrl.optional(),
  MEDIA_STORAGE_REGION: z.string().min(1).default("auto"),
  MEDIA_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "Nome de bucket inválido (3 a 63 letras minúsculas, números, ponto ou hífen).")
    .optional(),
  MEDIA_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  MEDIA_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** true para MinIO (endereço /bucket/chave); R2 aceita os dois. */
  MEDIA_STORAGE_FORCE_PATH_STYLE: bool,
  /** auto (padrão): URL assinada quando o provedor consegue buscar; senão base64. Só vale para o provedor QR (Evolution). */
  MEDIA_SEND_MODE: z.enum(MEDIA_SEND_MODES, { error: `MEDIA_SEND_MODE inválido. Use um destes: ${MEDIA_SEND_MODES.join(", ")}.` }).default("auto"),
});

export type StorageConfig = {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

const REQUIRED = ["MEDIA_STORAGE_ENDPOINT", "MEDIA_STORAGE_BUCKET", "MEDIA_STORAGE_ACCESS_KEY_ID", "MEDIA_STORAGE_SECRET_ACCESS_KEY"] as const;

/** Variáveis do armazenamento faltando (só quando ALGUMA foi definida: tudo vazio é "recurso desligado", não erro). */
export function missingStorageVars(source: NodeJS.ProcessEnv): string[] {
  const set = (name: string) => Boolean(source[name]?.trim());
  const any = [...REQUIRED, "MEDIA_STORAGE_PUBLIC_ENDPOINT"].some(set);
  return any ? REQUIRED.filter((name) => !set(name)) : [];
}

/** Configuração do armazenamento, ou `null` se o recurso está desligado (variáveis ausentes). Lança se algo definido é inválido. */
export function loadStorageConfig(source: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([key, value]) => key.startsWith("MEDIA_") && value !== undefined && value.trim() !== ""));
  const parsed = storageEnvSchema.parse(cleaned);
  if (!parsed.MEDIA_STORAGE_ENDPOINT || !parsed.MEDIA_STORAGE_BUCKET || !parsed.MEDIA_STORAGE_ACCESS_KEY_ID || !parsed.MEDIA_STORAGE_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: parsed.MEDIA_STORAGE_ENDPOINT.replace(/\/+$/, ""),
    publicEndpoint: (parsed.MEDIA_STORAGE_PUBLIC_ENDPOINT ?? parsed.MEDIA_STORAGE_ENDPOINT).replace(/\/+$/, ""),
    region: parsed.MEDIA_STORAGE_REGION,
    bucket: parsed.MEDIA_STORAGE_BUCKET,
    accessKeyId: parsed.MEDIA_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: parsed.MEDIA_STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: parsed.MEDIA_STORAGE_FORCE_PATH_STYLE ?? false,
  };
}

// ── interface ───────────────────────────────────────────────────────────────

export type ObjectHead = { sizeBytes: number; contentType: string | null };

export type PresignedPut = { url: string; headers: Record<string, string> };

export interface ObjectStorage {
  /**
   * URL assinada para o navegador fazer PUT. Assina o `Content-Type` e o `Content-Length` EXATOS: o armazenamento recusa
   * um arquivo de outro tipo ou tamanho. Os cabeçalhos devolvidos precisam ir no PUT (o navegador define o Content-Length sozinho).
   */
  presignPut(key: string, options: { contentType: string; contentLength: number; expiresInSeconds: number }): Promise<PresignedPut>;
  /** URL assinada de leitura (curta). `fileName`+`attachment` forçam o download com o nome certo; `contentType` fixa o tipo servido. */
  presignGet(key: string, options: { expiresInSeconds: number; contentType?: string; fileName?: string; attachment?: boolean }): Promise<string>;
  /** Tamanho e tipo do objeto, ou null se não existe. */
  head(key: string): Promise<ObjectHead | null>;
  /** Bytes `[start, endInclusive]` (os primeiros bytes para conferir o tipo real). null se não existe. */
  getRange(key: string, start: number, endInclusive: number): Promise<Buffer | null>;
  /** Objeto inteiro, no máximo `maxBytes` (maior que isso = lança). null se não existe. */
  getObject(key: string, options: { maxBytes: number }): Promise<Buffer | null>;
  put(key: string, body: Buffer, options: { contentType: string }): Promise<void>;
  /** Apagar objeto inexistente não é erro. */
  delete(key: string): Promise<void>;
  /** Devolve quantos objetos foram pedidos para apagar (inexistentes contam como apagados). */
  deleteMany(keys: readonly string[]): Promise<number>;
  /** Apaga TUDO sob o prefixo (ex.: `org/<id>/` ao apagar uma empresa). Devolve quantos objetos. */
  deletePrefix(prefix: string): Promise<number>;
  /** Quantos objetos e bytes há sob o prefixo (conferir antes de apagar). */
  countPrefix(prefix: string): Promise<{ objects: number; bytes: number }>;
  /** Subprefixos imediatos (`org/` → `org/<id>/`…): descobre empresas que ainda têm arquivos. */
  listPrefixes(prefix: string): Promise<string[]>;
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super("Objeto maior que o limite.");
    this.name = "ObjectTooLargeError";
  }
}

/** Chave segura: sem `..`, sem barra inicial, sem caracteres de controle. */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 512 || key.startsWith("/") || key.includes("..") || key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("Chave de objeto inválida.");
  }
}

function assertSafePrefix(prefix: string): void {
  assertSafeKey(prefix);
  if (!prefix.endsWith("/") || prefix.split("/").filter(Boolean).length < 2) throw new Error("Prefixo inválido: use org/<id>/.");
}

// ── S3 (R2, MinIO, S3) ──────────────────────────────────────────────────────

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

/** `Content-Disposition` com nome seguro (ASCII + `filename*` UTF-8). */
export function contentDisposition(fileName: string, attachment: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${attachment ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export class S3ObjectStorage implements ObjectStorage {
  /** Chamadas reais (rede interna) */
  private readonly client: S3Client;
  /** Só assina URLs (offline) com o host que o navegador enxerga */
  private readonly signer: S3Client;

  constructor(private readonly config: StorageConfig) {
    const base = {
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // sem checksum automático: ele entraria na URL assinada (CRC32 do corpo vazio) e o PUT do navegador seria recusado
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
    };
    this.client = new S3Client({ ...base, endpoint: config.endpoint, requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 } });
    this.signer = config.publicEndpoint === config.endpoint ? this.client : new S3Client({ ...base, endpoint: config.publicEndpoint });
  }

  async presignPut(key: string, options: { contentType: string; contentLength: number; expiresInSeconds: number }): Promise<PresignedPut> {
    assertSafeKey(key);
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: options.contentType, ContentLength: options.contentLength }),
      { expiresIn: options.expiresInSeconds, signableHeaders: new Set(["content-type", "content-length"]) },
    );
    return { url, headers: { "Content-Type": options.contentType } };
  }

  async presignGet(key: string, options: { expiresInSeconds: number; contentType?: string; fileName?: string; attachment?: boolean }): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
        ...(options.fileName ? { ResponseContentDisposition: contentDisposition(options.fileName, options.attachment ?? false) } : {}),
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }));
      return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
    } catch (error) {
      if (isNotFound(error)) return null;
      // objeto vazio: o intervalo não existe
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416) return Buffer.alloc(0);
      throw error;
    }
  }

  async getObject(key: string, options: { maxBytes: number }): Promise<Buffer | null> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (out.ContentLength !== undefined && out.ContentLength > options.maxBytes) {
        out.Body?.transformToWebStream?.().cancel().catch(() => {});
        throw new ObjectTooLargeError();
      }
      const bytes = Buffer.from((await out.Body?.transformToByteArray()) ?? []);
      if (bytes.length > options.maxBytes) throw new ObjectTooLargeError();
      return bytes;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(key: string, body: Buffer, options: { contentType: string }): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: body, ContentType: options.contentType, ContentLength: body.length }));
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    const unique = [...new Set(keys)];
    unique.forEach(assertSafeKey);
    for (let i = 0; i < unique.length; i += 1000) {
      const batch = unique.slice(i, i + 1000);
      const out = await this.client.send(new DeleteObjectsCommand({ Bucket: this.config.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      if (out.Errors?.length) throw new Error(`Falha ao apagar ${out.Errors.length} objeto(s).`);
    }
    return unique.length;
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertSafePrefix(prefix);
    let total = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
      if (keys.length) total += await this.deleteMany(keys);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  async countPrefix(prefix: string): Promise<{ objects: number; bytes: number }> {
    assertSafePrefix(prefix);
    const total = { objects: 0, bytes: 0 };
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of page.Contents ?? []) {
        total.objects++;
        total.bytes += o.Size ?? 0;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    assertSafeKey(prefix);
    const out: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token, MaxKeys: 1000 }));
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

// ── em memória (testes) ─────────────────────────────────────────────────────

export type MemoryObject = { bytes: Buffer; contentType: string };

/**
 * URL falsa mas inspecionável: `<urlBase>/put|get/<chave>?...` (padrão `memory:/`). Testes leem `presigned` e gravam com
 * `simulatePut` o que o navegador faria. `urlBase: "https://media.exemplo.com"` simula um armazenamento https.
 */
export class MemoryObjectStorage implements ObjectStorage {
  constructor(private readonly urlBase = "memory:/") {}

  readonly objects = new Map<string, MemoryObject>();
  /** Pedidos de assinatura (para o teste conferir limites e tipo). */
  readonly presigned: { op: "put" | "get"; key: string; contentType?: string; contentLength?: number; fileName?: string; attachment?: boolean; expiresInSeconds: number }[] = [];
  /** Força falha numa operação (simula armazenamento fora do ar). */
  failWith: Error | null = null;

  private guard() {
    if (this.failWith) throw this.failWith;
  }

  async presignPut(key: string, options: { contentType: string; contentLength: number; expiresInSeconds: number }): Promise<PresignedPut> {
    this.guard();
    assertSafeKey(key);
    this.presigned.push({ op: "put", key, contentType: options.contentType, contentLength: options.contentLength, expiresInSeconds: options.expiresInSeconds });
    return { url: `${this.urlBase}/put/${key}?len=${options.contentLength}&exp=${options.expiresInSeconds}`, headers: { "Content-Type": options.contentType } };
  }

  async presignGet(key: string, options: { expiresInSeconds: number; contentType?: string; fileName?: string; attachment?: boolean }): Promise<string> {
    this.guard();
    assertSafeKey(key);
    this.presigned.push({ op: "get", key, contentType: options.contentType, fileName: options.fileName, attachment: options.attachment, expiresInSeconds: options.expiresInSeconds });
    return `${this.urlBase}/get/${key}?exp=${options.expiresInSeconds}`;
  }

  /** O que o navegador faria com a URL do `presignPut`. */
  simulatePut(key: string, bytes: Buffer, contentType: string) {
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
  }

  async head(key: string): Promise<ObjectHead | null> {
    this.guard();
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.bytes.length, contentType: o.contentType } : null;
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer | null> {
    this.guard();
    const o = this.objects.get(key);
    return o ? Buffer.from(o.bytes.subarray(start, endInclusive + 1)) : null;
  }

  async getObject(key: string, options: { maxBytes: number }): Promise<Buffer | null> {
    this.guard();
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.bytes.length > options.maxBytes) throw new ObjectTooLargeError();
    return Buffer.from(o.bytes);
  }

  async put(key: string, body: Buffer, options: { contentType: string }): Promise<void> {
    this.guard();
    assertSafeKey(key);
    this.objects.set(key, { bytes: Buffer.from(body), contentType: options.contentType });
  }

  async delete(key: string): Promise<void> {
    this.guard();
    this.objects.delete(key);
  }

  async deleteMany(keys: readonly string[]): Promise<number> {
    this.guard();
    for (const key of new Set(keys)) this.objects.delete(key);
    return new Set(keys).size;
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.guard();
    assertSafePrefix(prefix);
    let n = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        n++;
      }
    }
    return n;
  }

  async countPrefix(prefix: string): Promise<{ objects: number; bytes: number }> {
    this.guard();
    assertSafePrefix(prefix);
    const total = { objects: 0, bytes: 0 };
    for (const [key, o] of this.objects) {
      if (key.startsWith(prefix)) {
        total.objects++;
        total.bytes += o.bytes.length;
      }
    }
    return total;
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    this.guard();
    assertSafeKey(prefix);
    const found = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const slash = key.indexOf("/", prefix.length);
      if (slash > 0) found.add(key.slice(0, slash + 1));
    }
    return [...found].sort();
  }
}

export function createS3Storage(config: StorageConfig): ObjectStorage {
  return new S3ObjectStorage(config);
}
