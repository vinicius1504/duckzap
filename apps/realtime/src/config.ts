import { z } from "zod";

/** Erro de configuração: a mensagem lista os campos com problema, NUNCA os valores (REDIS_URL carrega senha). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const isOrigin = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
};

const isHttpUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const isRedisUrl = (value: string) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "redis:" || protocol === "rediss:";
  } catch {
    return false;
  }
};

const int = (name: string, def: number, min: number, max: number) =>
  z.coerce
    .number({ error: `${name} deve ser um número` })
    .int(`${name} deve ser inteiro`)
    .min(min, `${name} deve ser no mínimo ${min}`)
    .max(max, `${name} deve ser no máximo ${max}`)
    .default(def);

const bool = z
  .enum(["true", "false"], { error: "use true ou false" })
  .default("false")
  .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    REALTIME_PORT: int("REALTIME_PORT", 4001, 1, 65535),
    REALTIME_HOST: z.string().min(1).default("0.0.0.0"),
    /** Valkey/Redis de onde chegam os eventos publicados pela API. */
    REDIS_URL: z
      .string({ error: "obrigatória" })
      .refine(isRedisUrl, "deve ser uma URL redis:// ou rediss://"),
    /** Endereço da API visto a partir deste servidor (rede interna). */
    API_INTERNAL_URL: z.string().refine(isHttpUrl, "deve ser uma URL http(s)").default("http://127.0.0.1:4000"),
    /** Origens do navegador aceitas (mesma lista da API). */
    WEB_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .refine((list) => list.length > 0, "informe ao menos uma origem")
      .refine((list) => list.every(isOrigin), "cada origem deve ser http(s)://host[:porta], sem barra final nem caminho"),
    REALTIME_MAX_CONNECTIONS_PER_USER: int("REALTIME_MAX_CONNECTIONS_PER_USER", 10, 1, 1000),
    REALTIME_MAX_CONNECTIONS_PER_IP: int("REALTIME_MAX_CONNECTIONS_PER_IP", 50, 1, 100_000),
    REALTIME_MAX_MESSAGE_BYTES: int("REALTIME_MAX_MESSAGE_BYTES", 1024, 16, 65_536),
    /** Mensagens do cliente aceitas por janela de 10 s (o legítimo manda 1 pong a cada 25 s). */
    REALTIME_CLIENT_MESSAGES_PER_10S: int("REALTIME_CLIENT_MESSAGES_PER_10S", 20, 1, 1000),
    REALTIME_PING_INTERVAL_MS: int("REALTIME_PING_INTERVAL_MS", 25_000, 100, 600_000),
    REALTIME_PONG_TIMEOUT_MS: int("REALTIME_PONG_TIMEOUT_MS", 60_000, 100, 3_600_000),
    REALTIME_REVALIDATE_INTERVAL_MS: int("REALTIME_REVALIDATE_INTERVAL_MS", 300_000, 1000, 86_400_000),
    REALTIME_AUTH_TIMEOUT_MS: int("REALTIME_AUTH_TIMEOUT_MS", 5000, 100, 60_000),
    /** true só atrás de proxy confiável (Caddy) que define X-Forwarded-For: usa o ÚLTIMO item como IP do cliente. */
    REALTIME_TRUST_PROXY: bool,
  })
  .refine((env) => env.REALTIME_PONG_TIMEOUT_MS > env.REALTIME_PING_INTERVAL_MS, {
    path: ["REALTIME_PONG_TIMEOUT_MS"],
    message: "deve ser maior que REALTIME_PING_INTERVAL_MS",
  });

export type RealtimeConfig = {
  port: number;
  host: string;
  redisUrl: string;
  apiInternalUrl: string;
  webOrigins: readonly string[];
  maxConnectionsPerUser: number;
  maxConnectionsPerIp: number;
  maxMessageBytes: number;
  clientMessagesPer10s: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  revalidateIntervalMs: number;
  authTimeoutMs: number;
  trustProxy: boolean;
};

/** Lê e valida o ambiente. Lança `ConfigError` (sem valores) se algo estiver errado; o processo recusa subir. */
export function parseConfig(env: Record<string, string | undefined>): RealtimeConfig {
  const problems: string[] = [];
  // em produção, nada de padrão silencioso para o que decide segurança
  if (env.NODE_ENV === "production") {
    for (const name of ["WEB_ORIGINS", "API_INTERNAL_URL"] as const) {
      if (!env[name]?.trim()) problems.push(`${name}: obrigatória em produção`);
    }
  }
  // variável vazia (`REALTIME_PORT=`) vale como ausente
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) cleaned[key] = value === "" ? undefined : value;

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "configuração";
      problems.push(`${field}: ${issue.message}`);
    }
  }
  if (problems.length > 0 || !parsed.success) {
    throw new ConfigError(`Configuração inválida do realtime:\n- ${problems.join("\n- ")}`);
  }
  const e = parsed.data;
  return {
    port: e.REALTIME_PORT,
    host: e.REALTIME_HOST,
    redisUrl: e.REDIS_URL,
    apiInternalUrl: e.API_INTERNAL_URL.replace(/\/+$/, ""),
    webOrigins: e.WEB_ORIGINS,
    maxConnectionsPerUser: e.REALTIME_MAX_CONNECTIONS_PER_USER,
    maxConnectionsPerIp: e.REALTIME_MAX_CONNECTIONS_PER_IP,
    maxMessageBytes: e.REALTIME_MAX_MESSAGE_BYTES,
    clientMessagesPer10s: e.REALTIME_CLIENT_MESSAGES_PER_10S,
    pingIntervalMs: e.REALTIME_PING_INTERVAL_MS,
    pongTimeoutMs: e.REALTIME_PONG_TIMEOUT_MS,
    revalidateIntervalMs: e.REALTIME_REVALIDATE_INTERVAL_MS,
    authTimeoutMs: e.REALTIME_AUTH_TIMEOUT_MS,
    trustProxy: e.REALTIME_TRUST_PROXY,
  };
}
