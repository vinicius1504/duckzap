import { Redis } from "ioredis";
import { ConfigError, parseConfig } from "./config";
import { createRealtimeServer } from "./server";
import { createApiSessionValidator } from "./session";

const SHUTDOWN_DEADLINE_MS = 10_000;

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: "realtime", msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main() {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    // só a lista de campos problemáticos; nunca valores
    console.error(error instanceof ConfigError ? error.message : "Configuração inválida do realtime.");
    process.exit(1);
  }

  // Conexão dedicada de assinatura. `autoResubscribe` refaz as assinaturas dos canais ativos após reconectar ao Valkey.
  const subscriber = new Redis(config.redisUrl, {
    autoResubscribe: true,
    // o ready check usa INFO, comando proibido em modo assinante (quebra na reconexão com canais ativos)
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  subscriber.on("error", (error: Error) => log("error", "valkey_error", { code: (error as NodeJS.ErrnoException).code ?? "unknown" }));
  subscriber.on("ready", () => log("info", "valkey_ready"));
  subscriber.on("end", () => log("warn", "valkey_connection_ended"));

  const server = createRealtimeServer({
    config,
    subscriber,
    validateSession: createApiSessionValidator({
      apiUrl: config.apiInternalUrl,
      origin: config.webOrigins[0] ?? "",
      timeoutMs: config.authTimeoutMs,
    }),
    subscriberHealthy: () => subscriber.status === "ready",
  });

  const port = await server.listen();
  log("info", "realtime_listening", { port, host: config.host });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "realtime_shutting_down", { signal });
    const force = setTimeout(() => {
      log("error", "realtime_shutdown_forced");
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    force.unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log("error", "realtime_boot_failed", { code: (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown" });
  process.exit(1);
});
