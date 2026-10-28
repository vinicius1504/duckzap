import type { ChannelStatus, ChannelType, ReplyMode } from "@duckzap/contracts/channels";
import type { ChipTone } from "@duckzap/ui/components/chip";

export const channelTypeLabel: Record<ChannelType, string> = {
  whatsapp_qr: "QR Code",
  whatsapp_official: "API oficial",
  instagram: "Instagram",
};

export const channelStatusView: Record<ChannelStatus, { label: string; tone: ChipTone }> = {
  connected: { label: "Conectado", tone: "ok" },
  qr_pending: { label: "Aguardando leitura", tone: "info" },
  awaiting_authorization: { label: "Aguardando", tone: "warn" },
  disconnected: { label: "Desconectado", tone: "err" },
  banned: { label: "Bloqueado", tone: "err" },
};

/** Texto da ação de conexão conforme o tipo e o status. */
export function connectLabel(type: ChannelType, status: ChannelStatus) {
  if (type === "instagram") return "Autorizar";
  if (status === "disconnected") return "Reconectar";
  return "Conectar";
}

export const inactivityOptions = [
  { value: 10, label: "10 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hora" },
] as const;

/** Modos de resposta do canal: rótulo curto e o que muda na prática. */
export const replyModeOptions: readonly { value: ReplyMode; label: string; hint: string }[] = [
  {
    value: "ai",
    label: "Somente IA",
    hint: "O agente de IA cumprimenta e atende. Nenhuma mensagem automática é enviada antes dele.",
  },
  {
    value: "auto",
    label: "Automático, sem IA",
    hint: "Envia as mensagens automáticas abaixo e a IA não atende: as conversas novas vão para a fila da equipe.",
  },
];
