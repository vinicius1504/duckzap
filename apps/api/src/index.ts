import { assertLlmConfigForEnv, createLlm, llmEnvSchema } from "@duckzap/ai";
import { serve } from "@hono/node-server";
import { createDb } from "@duckzap/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv, withoutEmpty } from "./env";
import { startBackgroundJobs, stopBackgroundJobs } from "./jobs";
import { createMailer } from "./lib/mailer";
import { closeRealtime, initRealtime } from "./lib/realtime";
import { getMediaRuntime } from "./modules/media/runtime";

/** Tempo máximo para encerrar com calma (requisições em andamento, jobs, pool) antes de forçar a saída. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = loadEnv();

// IA por interface única: trocar de provedor é configuração (LLM_PROVIDER), não código
const llmConfig = llmEnvSchema.safeParse(withoutEmpty(process.env));
if (!llmConfig.success) {
  fatal(
    ["Configuração de IA inválida. Corrija o .env e suba de novo:", ...llmConfig.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`)].join("\n"),
  );
}
try {
  // provedor "fake" não sobe em produção (responderia clientes reais com texto de teste)
  assertLlmConfigForEnv({ ...llmConfig.data, NODE_ENV: env.NODE_ENV });
} catch (error) {
  fatal(`Configuração de IA inválida: ${error instanceof Error ? error.message : "erro desconhecido"}`);
}

const { db, close } = createDb(env.DATABASE_URL);
const auth = createAuth({ env, db, sendMail: createMailer(env) });
const llm = createLlm(llmConfig.data);
const deps = { env, db, auth, llm };
const app = createApp(deps);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`API ouvindo em http://localhost:${info.port}`);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  fatal(
    error.code === "EADDRINUSE"
      ? `A porta ${env.PORT} já está em uso. Mude PORT no .env ou encerre o outro processo.`
      : `Falha ao abrir a porta ${env.PORT}: ${error.message}`,
  );
});

// mídia das conversas: sem MEDIA_STORAGE_* o envio e o recebimento de arquivos ficam desligados (o resto segue normal)
console.log(getMediaRuntime().storage ? `[media] armazenamento de arquivos ligado (envio ao WhatsApp: ${getMediaRuntime().sendMode})` : "[media] armazenamento de arquivos desligado (defina MEDIA_STORAGE_*)");

// jobs em segundo plano (varredura de campanhas, IA vencida, eventos de entrada); param no shutdown
startBackgroundJobs({ db, llm });

// tempo real: publica avisos no Valkey (REDIS_URL opcional; sem ela só avisa uma vez e segue)
initRealtime();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} recebido, encerrando…`);
  const force = setTimeout(() => {
    console.error(`Encerramento passou de ${SHUTDOWN_TIMEOUT_MS / 1000}s; forçando a saída.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();
  try {
    await stopBackgroundJobs();
    await closeRealtime();
    // para de aceitar conexões e fecha as ociosas; as em andamento terminam
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeIdleConnections" in server) server.closeIdleConnections();
    });
    await close();
    process.exit(0);
  } catch (error) {
    console.error("Erro ao encerrar:", error);
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// erro sem tratamento: registra e encerra (o supervisor reinicia); nunca fica rodando em estado desconhecido
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
  void shutdown("uncaughtException");
});
