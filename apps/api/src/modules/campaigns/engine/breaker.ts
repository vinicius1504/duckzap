import type { CampaignPauseReason } from "@duckzap/contracts/campaigns";

// Parada automática (circuit breaker, §5.7 item 5). Pura: recebe os últimos resultados e diz se pausa e por quê.

export type Outcome = "ok" | "failed" | "opt_out";

export type BreakerRules = {
  /** Quantos envios recentes olhar. */
  windowSize: number;
  /** Pausa se falhas > este percentual (0,10 = 10%) do tamanho da janela. */
  failureRate: number;
  /** Pausa com este número de saídas/denúncias na janela. */
  optOuts: number;
};

/** Campanha: >10% de falhas nas últimas 20; 3+ saídas/denúncias nas últimas 20. */
export const CAMPAIGN_BREAKER: BreakerRules = { windowSize: 20, failureRate: 0.1, optOuts: 3 };

/** Convite de consentimento (§5.7 item 7): mais sensível. 3 recusas ou 2 falhas nas últimas 15. Reusável pelo worker de convites. */
export const INVITE_BREAKER = { windowSize: 15, refusals: 3, failures: 2 } as const;

export type BreakerInput = {
  channelConnected: boolean;
  /** Erro do provedor indicando restrição/banimento do número. */
  providerRestriction: boolean;
  /** Resultados mais recentes primeiro. Só considera os `windowSize` primeiros. */
  recent: readonly Outcome[];
  rules?: BreakerRules;
};

export type BreakerVerdict = { pause: false } | { pause: true; reason: CampaignPauseReason; detail: string };

export function evaluateBreaker(input: BreakerInput): BreakerVerdict {
  const rules = input.rules ?? CAMPAIGN_BREAKER;
  if (!input.channelConnected) {
    return { pause: true, reason: "channel_disconnected", detail: "O canal desconectou durante o envio." };
  }
  if (input.providerRestriction) {
    return { pause: true, reason: "provider_restriction", detail: "O provedor devolveu um erro indicando restrição no número." };
  }
  const window = input.recent.slice(0, rules.windowSize);
  const failures = window.filter((o) => o === "failed").length;
  const optOuts = window.filter((o) => o === "opt_out").length;
  // com menos de `windowSize` envios, o denominador continua sendo `windowSize`: 3 falhas nos primeiros 5 já pausam
  const denominator = Math.max(window.length, rules.windowSize);
  if (failures > rules.failureRate * denominator) {
    return { pause: true, reason: "high_failure_rate", detail: `${failures} falhas nas últimas ${window.length} mensagens.` };
  }
  if (optOuts >= rules.optOuts) {
    return { pause: true, reason: "opt_outs", detail: `${optOuts} pessoas pediram para sair nas últimas ${window.length} mensagens.` };
  }
  return { pause: false };
}

/** Convites (§5.7 item 7): 3 recusas/denúncias ou 2 falhas nas últimas 15. */
export function evaluateInviteBreaker(recent: readonly Outcome[]): boolean {
  const window = recent.slice(0, INVITE_BREAKER.windowSize);
  return (
    window.filter((o) => o === "opt_out").length >= INVITE_BREAKER.refusals ||
    window.filter((o) => o === "failed").length >= INVITE_BREAKER.failures
  );
}

// ---------- classificação de falhas de envio ----------

export type SendFailure = { code: string; message: string };
export type FailureKind = "restriction" | "no_whatsapp" | "transient" | "failed";

const RESTRICTION = /restri|banid|banned|\bban\b|blocked|bloquead|spam|suspens|suspend|violat|polic/i;
const NO_WHATSAPP = /not on whatsapp|n[aã]o (est[aá]|possui|tem).{0,20}whatsapp|no whatsapp|exists.{0,6}false|n[uú]mero.{0,20}(inv[aá]lido|inexistente)|invalid (number|phone|jid)/i;

/** Falha do `sendViaChannel` → o que o motor faz com o destinatário e a campanha. */
export function classifyFailure(failure: SendFailure): FailureKind {
  if (failure.code === "rate_limited" || failure.code === "plan_paused" || failure.code === "disconnected") return "transient";
  if (RESTRICTION.test(failure.message)) return "restriction";
  if (NO_WHATSAPP.test(failure.message)) return "no_whatsapp";
  return "failed";
}
