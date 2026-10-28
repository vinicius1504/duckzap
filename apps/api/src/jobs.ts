import type { Database } from "@duckzap/db";
import type { LLMProvider } from "@duckzap/ai";
import { z } from "zod";
import { loadAgentsConfig } from "./modules/agents/config";
import { loadCampaignsConfig } from "./modules/campaigns/config";
import { createCampaignsRuntime, getSharedCampaignsRuntime, setSharedCampaignsRuntime } from "./modules/campaigns/ports";
import { startInlineScheduler, stopInlineScheduler } from "./modules/campaigns/scheduler";
import { purgeInboundEvents, reprocessPending } from "./modules/channels/inbound-store";
import { syncPresenceWebhooks } from "./modules/channels/presence-sync";
import { getChannelsRuntime } from "./modules/channels/runtime";
import { suspendLapsedAccounts } from "./modules/channels/suspension";
import { sweepAll, sweepInactivity, createAiRateLimiters, type AiDeps } from "./modules/conversations/ai-turn";
import { loadConversationsConfig } from "./modules/conversations/config";
import { getConversationsRuntime } from "./modules/conversations/runtime";

/**
 * Tarefas de fundo DENTRO da API (mecanismo padrão enquanto não existe o apps/worker com BullMQ). O `index.ts` chama
 * `startBackgroundJobs({ db, llm })` depois de subir o servidor e `await stopBackgroundJobs()` no shutdown.
 *
 * Todas são idempotentes e seguras com várias instâncias (a trava está no banco: `FOR UPDATE SKIP LOCKED`, lock por
 * linha, advisory lock por conversa), não se sobrepõem a si mesmas, usam `unref` (não seguram o processo) e param no shutdown.
 *
 *   campanhas        runCampaignTick (empresas de `dz_orgs_with_due_campaigns`)      a cada CAMPAIGNS_SWEEP_SECONDS (padrão 15 s; CAMPAIGNS_SCHEDULER=off desliga)
 *   conversas        respostas de IA vencidas (`dz_orgs_with_due_conversations`)       a cada CONVERSATIONS_SWEEP_INTERVAL_MS (padrão 30 s; 0 desliga)
 *   inatividade      encerramento por inatividade de todas as empresas, em páginas     a cada hora
 *   entrada          reprocessPending dos eventos de webhook pendentes/falhos          a cada INBOUND_REPROCESS_SECONDS (padrão 30 s; 0 desliga)
 *   suspensão        desconecta canais WhatsApp de contas suspensas                    a cada SUSPENSION_SWEEP_MINUTES (padrão 15 min; 0 desliga)
 *   retenção (LGPD)  purgeInboundEvents (minimiza/apaga eventos brutos antigos)        a cada INBOUND_PURGE_HOURS (padrão 24 h; 0 desliga)
 *   presença         reaplica o webhook da Evolution com PRESENCE_UPDATE nas instâncias   1x ~30 s após subir e a cada 24 h
 *                    QR já conectadas (idempotente: consulta antes de escrever)           (PRESENCE_ENABLED=false ou PRESENCE_WEBHOOK_SYNC=false desliga)
 */

const jobsConfigSchema = z.object({
  BACKGROUND_JOBS: z.enum(["on", "off"]).default("on"),
  INBOUND_REPROCESS_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  SUSPENSION_SWEEP_MINUTES: z.coerce.number().int().min(0).max(1440).default(15),
  INBOUND_PURGE_HOURS: z.coerce.number().int().min(0).max(24 * 30).default(24),
  INBOUND_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
});
export type JobsConfig = z.infer<typeof jobsConfigSchema>;

export type BackgroundJobsDeps = { db: Database; llm: LLMProvider; env?: NodeJS.ProcessEnv; log?: JobsLog };
type JobsLog = { warn(message: string, meta?: Record<string, unknown>): void; error(message: string, meta?: Record<string, unknown>): void };

const consoleLog: JobsLog = {
  warn: (message, meta) => console.warn(message, meta ?? ""),
  error: (message, meta) => console.error(message, meta ?? ""),
};

type Job = { name: string; timer: NodeJS.Timeout; first?: NodeJS.Timeout; inFlight: Promise<unknown> | null };
let jobs: Job[] = [];
let started = false;

function every(list: Job[], name: string, ms: number, log: JobsLog, run: () => Promise<unknown>, options: { firstRunAfterMs?: number } = {}) {
  const job: Job = { name, timer: undefined as unknown as NodeJS.Timeout, inFlight: null };
  const tick = () => {
    if (job.inFlight) return; // sem sobreposição
    job.inFlight = run()
      .catch((error: unknown) => log.error("jobs.failed", { job: name, error: error instanceof Error ? error.name : "unknown" }))
      .finally(() => {
        job.inFlight = null;
      });
  };
  job.timer = setInterval(tick, ms);
  job.timer.unref();
  if (options.firstRunAfterMs !== undefined) {
    job.first = setTimeout(tick, options.firstRunAfterMs);
    job.first.unref();
  }
  list.push(job);
}

export function startBackgroundJobs(deps: BackgroundJobsDeps): void {
  if (started) return;
  const env = deps.env ?? process.env;
  const log = deps.log ?? consoleLog;
  const config = jobsConfigSchema.parse(env);
  if (config.BACKGROUND_JOBS === "off") return;
  started = true;
  const list: Job[] = [];

  // --- campanhas ---
  const campaigns = loadCampaignsConfig(env);
  if (campaigns.CAMPAIGNS_SCHEDULER === "inline") {
    let rt = getSharedCampaignsRuntime();
    if (!rt) {
      rt = createCampaignsRuntime({ db: deps.db, llm: deps.llm });
      setSharedCampaignsRuntime(rt);
    }
    startInlineScheduler(rt, campaigns.CAMPAIGNS_SWEEP_SECONDS);
  }

  // --- conversas: respostas de IA vencidas e encerramento por inatividade ---
  const conversations = loadConversationsConfig(env);
  const aiDeps = (): { ai: AiDeps; limiters: ReturnType<typeof createAiRateLimiters> } => {
    const runtime = getConversationsRuntime();
    if (runtime) return { ai: runtime.ai, limiters: runtime.limiters };
    const limiters = createAiRateLimiters(conversations);
    return {
      limiters,
      ai: { db: deps.db, llm: deps.llm, config: conversations, urlAllowlist: loadAgentsConfig().AGENTS_URL_ALLOWLIST, now: () => new Date(), log },
    };
  };
  if (conversations.CONVERSATIONS_SWEEP_INTERVAL_MS > 0) {
    every(list, "conversations.sweep", conversations.CONVERSATIONS_SWEEP_INTERVAL_MS, log, async () => {
      const { ai, limiters } = aiDeps();
      await sweepAll(ai, limiters);
    });
    every(list, "conversations.inactivity", 60 * 60_000, log, async () => {
      await sweepInactivity(aiDeps().ai);
    }, { firstRunAfterMs: 60_000 });
  }

  // --- entrada de webhooks: pendentes e falhos ---
  if (config.INBOUND_REPROCESS_SECONDS > 0) {
    every(list, "inbound.reprocess", config.INBOUND_REPROCESS_SECONDS * 1000, log, () => reprocessPending(deps.db, getChannelsRuntime()));
  }

  // --- conta suspensa desconecta o WhatsApp (idempotente; reativar NÃO reconecta sozinho) ---
  if (config.SUSPENSION_SWEEP_MINUTES > 0) {
    every(list, "channels.suspension", config.SUSPENSION_SWEEP_MINUTES * 60_000, log, () => suspendLapsedAccounts(deps.db, getChannelsRuntime()), { firstRunAfterMs: 30_000 });
  }

  // --- retenção LGPD dos eventos brutos ---
  if (config.INBOUND_PURGE_HOURS > 0) {
    every(
      list,
      "inbound.purge",
      config.INBOUND_PURGE_HOURS * 3_600_000,
      log,
      () => purgeInboundEvents(deps.db, { olderThanDays: config.INBOUND_RETENTION_DAYS }),
      { firstRunAfterMs: 2 * 60_000 },
    );
  }

  // --- "digitando…": instâncias QR criadas antes do PRESENCE_UPDATE precisam do evento no webhook (idempotente) ---
  const channels = getChannelsRuntime();
  if (channels.config.presenceWebhookSync) {
    every(list, "channels.presence_webhook_sync", 24 * 3_600_000, log, async () => {
      const result = await syncPresenceWebhooks(deps.db, channels);
      if (result.channels > 0) log.warn("channels.presence_sync.done", { ...result });
    }, { firstRunAfterMs: 30_000 });
  }
  jobs = list;
}

/** Para tudo e espera (até `timeoutMs`) as tarefas em andamento. Seguro chamar mais de uma vez. */
export async function stopBackgroundJobs(timeoutMs = 10_000): Promise<void> {
  const current = jobs;
  jobs = [];
  started = false;
  for (const job of current) {
    clearInterval(job.timer);
    if (job.first) clearTimeout(job.first);
  }
  const waits = [stopInlineScheduler(timeoutMs), ...current.map((j) => j.inFlight).filter((p): p is Promise<unknown> => p !== null)];
  await Promise.race([Promise.allSettled(waits), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}
