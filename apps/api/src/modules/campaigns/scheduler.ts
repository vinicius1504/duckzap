import type { CampaignsRuntime } from "./ports";
import { runCampaignTick } from "./runner";

// Agendador da própria API: varre as empresas com campanhas vencidas a cada N segundos (mecanismo PADRÃO, ligado por
// `startBackgroundJobs` em src/jobs.ts). O estado de verdade está no banco (`campaigns.next_send_at`) e `runCampaignTick`
// é idempotente com trava por linha: reiniciar a API não perde campanha e duas instâncias não enviam em dobro.
// Os jobs atrasados em memória (`rt.queue`) são só uma otimização para acordar no instante exato.

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;

export function startInlineScheduler(rt: CampaignsRuntime, everySeconds: number) {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return; // sweeps não se sobrepõem
    inFlight = runCampaignTick(rt)
      .catch((error: unknown) => rt.log.error("campaigns.sweep_failed", { error: error instanceof Error ? error.name : "unknown" }))
      .finally(() => {
        inFlight = null;
      });
  }, everySeconds * 1000);
  timer.unref();
}

/** Para o agendador e espera (até `timeoutMs`) o sweep em andamento terminar. */
export async function stopInlineScheduler(timeoutMs = 10_000) {
  if (timer) clearInterval(timer);
  timer = null;
  const pending = inFlight;
  if (pending) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}
