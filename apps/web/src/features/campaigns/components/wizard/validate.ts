import { INTERVAL_FLOOR_SECONDS, MIN_APPROVED_VARIATIONS } from "@duckzap/contracts/campaigns";
import type { Draft, WizardContext } from "./types";

// Conferência no navegador só para orientar; o servidor confere tudo de novo ao disparar.

export function channelOf(draft: Draft, ctx: WizardContext) {
  return ctx.channels.find((c) => c.id === draft.sending.channelId) ?? null;
}

export function audienceOf(draft: Draft, ctx: WizardContext) {
  return ctx.audiences.find((a) => a.id === draft.audienceId) ?? null;
}

export function bankIsStale(draft: Draft) {
  return draft.variations.length > 0 && (draft.variationsBase ?? "").trim() !== draft.message.body.trim();
}

export function validateStep(step: number, draft: Draft, ctx: WizardContext): string[] {
  const errors: string[] = [];
  const channel = channelOf(draft, ctx);
  const isQr = channel?.kind === "whatsapp_qr";
  if (step === 0) {
    if (!draft.name.trim()) errors.push("Dê um nome para a campanha.");
    const audience = audienceOf(draft, ctx);
    if (!audience) errors.push("Escolha uma lista ou segmento.");
    else if (audience.optedIn === 0) errors.push("Este público não tem ninguém que aceitou receber mensagens.");
    if (!channel) errors.push("Escolha por qual número enviar.");
    else if (!channel.connected) errors.push(`${channel.name} está desconectado. Reconecte ou escolha outro número.`);
  }
  if (step === 1) {
    const m = draft.message;
    if (!isQr) {
      const tpl = ctx.metaTemplates.find((t) => t.id === m.officialTemplateId);
      if (tpl?.metaStatus !== "approved") errors.push("Escolha um modelo aprovado pela Meta.");
      return errors;
    }
    if (m.body.trim().length < 10) errors.push("Escreva a mensagem base.");
    if (m.type === "text_image" && !m.imageName) errors.push("Escolha a imagem da mensagem.");
    if (m.type === "buttons" && !m.buttons.some((b) => b.trim())) errors.push("Adicione pelo menos um botão.");
    if (m.type === "list" && (!m.listButtonLabel.trim() || !m.listItems.length)) errors.push("Dê um nome ao botão do menu e adicione opções.");
    if (!draft.variations.length) errors.push("Gere o banco de variações e revise antes de continuar.");
    else if (bankIsStale(draft)) errors.push("A mensagem mudou depois de gerar as variações. Gere de novo.");
    else {
      const approved = draft.variations.filter((v) => v.review === "approved").length;
      const pending = draft.variations.filter((v) => v.review === "pending").length;
      if (pending) errors.push(`Revise as ${pending} variações pendentes (aprovar ou rejeitar).`);
      if (approved < MIN_APPROVED_VARIATIONS) errors.push(`Aprove pelo menos ${MIN_APPROVED_VARIATIONS} variações (agora: ${approved}).`);
    }
  }
  if (step === 2) {
    const s = draft.sending;
    if (s.scheduleMode === "scheduled") {
      if (!s.scheduledAt) errors.push("Escolha a data e a hora do envio.");
      else if (new Date(s.scheduledAt).getTime() < Date.now()) errors.push("A data do envio já passou.");
    }
    if (isQr) {
      if (s.intervalMinSeconds < INTERVAL_FLOOR_SECONDS) errors.push(`O intervalo mínimo é de ${INTERVAL_FLOOR_SECONDS} s.`);
      if (s.intervalMaxSeconds <= s.intervalMinSeconds) errors.push("O intervalo máximo precisa ser maior que o mínimo.");
    }
    if (s.windowEnd <= s.windowStart) errors.push("O fim da janela de envio precisa ser depois do início.");
  }
  return errors;
}
