import { createS3Storage, loadStorageConfig, type ObjectStorage, storageEnvSchema } from "../../lib/storage";
import { InMemoryTokenBucket, type RateLimiter } from "../channels/rate-limit";

/**
 * Dependências da mídia de conversa, no estilo de `ChannelsRuntime`: um padrão por processo, lido do ambiente na primeira
 * vez, e `setMediaRuntime` para testes. `storage: null` = recurso desligado (variáveis `MEDIA_STORAGE_*` ausentes).
 */
export type MediaRuntime = {
  storage: ObjectStorage | null;
  /** auto | url | base64 (ver `MEDIA_SEND_MODE`). */
  sendMode: "auto" | "url" | "base64";
  /** O endereço (interno) do armazenamento é https? Em `auto`, só então a Evolution recebe uma URL assinada. */
  storageIsHttps: boolean;
  /** Pedidos de envio (`POST /media/uploads`) por empresa. */
  initLimiter: RateLimiter;
  /** Conferências (`/complete`) por empresa. */
  completeLimiter: RateLimiter;
  now(): Date;
  log: { warn(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void };
};

const consoleLog = {
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ?? ""),
  error: (message: string, meta?: Record<string, unknown>) => console.error(message, meta ?? ""),
};

export function createMediaRuntime(overrides: Partial<MediaRuntime> = {}, source: NodeJS.ProcessEnv = process.env): MediaRuntime {
  let storage: ObjectStorage | null = null;
  let storageIsHttps = false;
  let sendMode: MediaRuntime["sendMode"] = "auto";
  try {
    sendMode = storageEnvSchema.shape.MEDIA_SEND_MODE.parse(source.MEDIA_SEND_MODE?.trim() || undefined);
    const config = loadStorageConfig(source);
    if (config) {
      storage = createS3Storage(config);
      storageIsHttps = config.endpoint.startsWith("https://");
    }
  } catch {
    // configuração inválida já foi reportada no boot (env.ts); aqui o recurso só fica desligado
    storage = null;
  }
  return {
    storage,
    sendMode,
    storageIsHttps,
    // 30 pedidos em rajada, 1 por segundo depois; a conferência é um pouco mais folgada (um pedido por arquivo)
    initLimiter: new InMemoryTokenBucket({ capacity: 30, refillPerSecond: 1 }),
    completeLimiter: new InMemoryTokenBucket({ capacity: 60, refillPerSecond: 2 }),
    now: () => new Date(),
    log: consoleLog,
    ...overrides,
  };
}

let shared: MediaRuntime | undefined;
export function getMediaRuntime(): MediaRuntime {
  shared ??= createMediaRuntime();
  return shared;
}
export function setMediaRuntime(runtime: MediaRuntime | undefined) {
  shared = runtime;
}
