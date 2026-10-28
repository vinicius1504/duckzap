import { CAMPAIGN_VARIABLES, MIN_APPROVED_VARIATIONS, type CampaignStatus } from "@duckzap/contracts/campaigns";
import { isValidWindow } from "./calendar";

// Pré-condições do disparo, puras (o service lê o banco e entrega os fatos). Ordem = a do front (mensagens em pt-BR).

export type LaunchError =
  | "not_found"
  | "not_draft"
  | "terms_required"
  | "no_audience"
  | "channel_unavailable"
  | "template_required"
  | "variations_required"
  | "invalid_message"
  | "invalid_window"
  | "invalid_schedule";

export type LaunchFacts = {
  status: CampaignStatus;
  /** Termos de campanhas aceitos (versão atual) por esta empresa. */
  termsAccepted: boolean;
  audienceId: string | null;
  eligibleRecipients: number;
  channel: { connected: boolean; kind: "whatsapp_qr" | "whatsapp_official" } | null;
  message: { body: string; optOutLine: string; type: string };
  template: { metaStatus: string | null; body: string } | null;
  variationsBase: string | null;
  variations: readonly { review: string; issues: readonly string[] }[];
  windowStart: string;
  windowEnd: string;
  scheduleMode: "now" | "scheduled";
  scheduledAt: Date | null;
  now: Date;
};

export type LaunchCheck = { ok: true } | { ok: false; error: LaunchError; message: string };

const bad = (error: LaunchError, message: string): LaunchCheck => ({ ok: false, error, message });
const OPT_OUT_WORDS = /sair|parar|descadastr|cancelar (o )?recebimento|stop/i;

export function checkLaunch(f: LaunchFacts): LaunchCheck {
  if (f.status !== "draft") return bad("not_draft", "Esta campanha já foi disparada.");
  // §5.4 / front: termos antes do PRIMEIRO disparo
  if (!f.termsAccepted) return bad("terms_required", "Aceite os termos de uso de campanhas antes do primeiro disparo.");
  if (!f.audienceId || f.eligibleRecipients === 0) {
    return bad("no_audience", "Escolha um público com pessoas que aceitaram receber.");
  }
  if (!f.channel?.connected) return bad("channel_unavailable", "O canal escolhido está desconectado. Reconecte ou escolha outro.");
  if (!isValidWindow(f.windowStart, f.windowEnd)) {
    return bad("invalid_window", "A janela de envio precisa começar antes de terminar, no mesmo dia.");
  }
  if (f.scheduleMode === "scheduled" && (!f.scheduledAt || f.scheduledAt.getTime() < f.now.getTime() - 60_000)) {
    return bad("invalid_schedule", "Escolha uma data e hora futuras para o agendamento.");
  }
  if (!f.message.optOutLine.trim() || !OPT_OUT_WORDS.test(f.message.optOutLine)) {
    return bad("invalid_message", "A linha de saída é obrigatória (ex.: “Responda SAIR para não receber mais.”).");
  }
  if (f.channel.kind === "whatsapp_official") {
    // API oficial: só modelo aprovado pela Meta, sem variação por IA (§3.6, §5.4)
    if (f.template?.metaStatus !== "approved") return bad("template_required", "Na API oficial, escolha um modelo aprovado pela Meta.");
    if (!OPT_OUT_WORDS.test(f.template.body)) {
      return bad("template_required", "O modelo escolhido precisa trazer a opção de saída (ex.: “Responda SAIR”).");
    }
    return { ok: true };
  }
  if (!f.message.body.trim()) return bad("invalid_message", "Escreva a mensagem da campanha.");
  const unknown = (f.message.body.match(/\{[a-z_]+\}/g) ?? []).find((v) => !(CAMPAIGN_VARIABLES as readonly string[]).includes(v));
  if (unknown) return bad("invalid_message", `A variável ${unknown} não existe. Use ${CAMPAIGN_VARIABLES.join(", ")}.`);
  if (f.variationsBase?.trim() !== f.message.body.trim()) {
    return bad("variations_required", "A mensagem mudou depois de gerar as variações. Gere o banco de novo.");
  }
  // só entra no sorteio a variação aprovada E sem problema no validador (recalculado no servidor)
  const usable = f.variations.filter((v) => v.review === "approved" && v.issues.length === 0).length;
  const pending = f.variations.some((v) => v.review === "pending");
  if (usable < MIN_APPROVED_VARIATIONS || pending) {
    return bad("variations_required", `Revise todas as variações e aprove pelo menos ${MIN_APPROVED_VARIATIONS}.`);
  }
  return { ok: true };
}
