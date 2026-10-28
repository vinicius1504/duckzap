import type {
  CampaignMessageType,
  CampaignPauseReason,
  CampaignRecipientStatus,
  CampaignStatus,
  VariationIssue,
} from "@duckzap/contracts/campaigns";
import type { ChipTone } from "@duckzap/ui/components/chip";

// O contrato não carrega nada visual: aqui o status vira texto e tom.

export const campaignStatusView: Record<CampaignStatus, { label: string; tone: ChipTone }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  scheduled: { label: "Agendada", tone: "warn" },
  sending: { label: "Enviando", tone: "info" },
  paused: { label: "Pausada", tone: "warn" },
  completed: { label: "Concluída", tone: "ok" },
  canceled: { label: "Cancelada", tone: "neutral" },
};

export const messageTypeLabel: Record<CampaignMessageType, string> = {
  text: "Texto",
  text_image: "Texto + imagem",
  buttons: "Botões de resposta",
  list: "Menu de lista",
};

export const pauseReasonView: Record<CampaignPauseReason, { title: string; hint: string }> = {
  manual: { title: "Pausada por você", hint: "Retome quando quiser. O envio continua de onde parou." },
  channel_disconnected: { title: "O canal desconectou", hint: "Reconecte o número em Canais e depois retome a campanha." },
  high_failure_rate: { title: "Muitas falhas de entrega", hint: "Mais de 10% das últimas 20 mensagens falharam. Confira o número antes de retomar." },
  opt_outs: { title: "Muitas pessoas pediram para sair", hint: "Revise a mensagem e o público antes de retomar. Isso protege seu número." },
  provider_restriction: { title: "O WhatsApp indicou restrição no número", hint: "Espere pelo menos 24 h antes de retomar e reduza o volume." },
  outside_window: { title: "Fora da janela de envio", hint: "O envio volta sozinho no próximo horário permitido." },
  subscription_expired: { title: "Plano expirado", hint: "Renove a assinatura para continuar enviando." },
};

export const recipientStatusView: Record<CampaignRecipientStatus, { label: string; tone: ChipTone }> = {
  queued: { label: "Na fila", tone: "neutral" },
  sent: { label: "Enviada", tone: "info" },
  delivered: { label: "Entregue", tone: "info" },
  read: { label: "Lida", tone: "ok" },
  replied: { label: "Respondeu", tone: "ok" },
  failed: { label: "Falha de entrega", tone: "warn" },
  opted_out: { label: "Pediu para sair", tone: "err" },
  no_whatsapp: { label: "Número sem WhatsApp", tone: "warn" },
};

export const variationIssueLabel: Record<VariationIssue, string> = {
  missing_variable: "Falta variável (ex.: {nome})",
  missing_link: "Falta o link da mensagem base",
  missing_opt_out: "Falta a linha de saída",
  unknown_number_or_link: "Número, preço ou link que não está na base",
  too_similar: "Parecida demais com outra",
  too_different: "Muito diferente da base",
};

/** Valores de exemplo para a prévia no celular. */
export const previewValues = { "{nome}": "Carla", "{empresa}": "Casa Alvorada", "{ultima_visita}": "12/04" };

/** [50, 14] → "2 dias (50 + 14)" */
export function describeSplit(days: readonly number[]) {
  if (days.length <= 1) return "1 dia";
  return `${days.length} dias (${days.join(" + ")})`;
}

/** Por que disparar/retomar está desligado (null = liberado). */
export function sendBlockedReason(subscriptionExpired: boolean, canSend: boolean) {
  if (subscriptionExpired) return "Envios pausados: seu plano expirou.";
  if (!canSend) return "Só administradores podem disparar campanhas.";
  return null;
}
