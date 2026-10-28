import type {
  ChannelKind,
  ConversationMode,
  ConversationPriority,
  ConversationSummary,
  ContactAppointment,
  InboxLookups,
  MessageStatus,
} from "@duckzap/contracts/conversations";
import type { ChipTone } from "@duckzap/ui/components/chip";
import { formatDate } from "@/lib/format";
import { formatDuration, formatFileSize, mediaPreviewLabel } from "@/lib/media";

// Mapeia o dado do contrato para texto e tom da tela. Puro: serve no server e no client.

export const MODE_OPTIONS = [
  { value: "ai", label: "IA responde" },
  { value: "copilot", label: "Copiloto (IA sugere)" },
  { value: "human", label: "Só humano" },
] as const satisfies readonly { value: ConversationMode; label: string }[];

export function modeHint(mode: ConversationMode, agentName: string) {
  switch (mode) {
    case "ai":
      return `O ${agentName} responde sozinho e chama uma pessoa se precisar.`;
    case "copilot":
      return "A IA escreve a sugestão e você decide se envia.";
    case "human":
      return "A IA fica de fora: só a equipe responde.";
  }
}

export const PRIORITY_LABEL: Record<ConversationPriority, { label: string; tone: ChipTone }> = {
  urgent: { label: "Urgente", tone: "err" },
  high: { label: "Alta", tone: "warn" },
  normal: { label: "Normal", tone: "neutral" },
  low: { label: "Baixa", tone: "neutral" },
};

export const CHANNEL_KIND_LABEL: Record<ChannelKind, string> = {
  whatsapp_qr: "WhatsApp",
  whatsapp_api: "WhatsApp API",
  instagram: "Instagram",
};

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  sending: "Enviando",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Não enviada",
};

export const APPOINTMENT_STATUS: Record<ContactAppointment["status"], { label: string; tone: ChipTone }> = {
  pending: { label: "pendente", tone: "warn" },
  confirmed: { label: "confirmado", tone: "ok" },
  reschedule: { label: "a remarcar", tone: "warn" },
  done: { label: "concluído", tone: "neutral" },
  canceled: { label: "cancelado", tone: "err" },
};

export const firstName = (name: string) => name.split(" ")[0] ?? name;

export function memberName(lookups: InboxLookups, id: string | null) {
  return id ? (lookups.members.find((m) => m.id === id)?.name ?? null) : null;
}

export function statusChip(c: ConversationSummary, lookups: InboxLookups): { label: string; tone: ChipTone } {
  switch (c.status) {
    case "ai_active":
      return { label: "IA atendendo", tone: "ok" };
    case "handoff_requested":
      return { label: "Aguardando", tone: "warn" };
    case "human_active": {
      const name = memberName(lookups, c.assigneeId);
      return { label: name ? `Humano · ${firstName(name)}` : "Humano", tone: "neutral" };
    }
    case "resolved":
      return c.resolvedBy === "ai" ? { label: "Resolvida pela IA", tone: "ok" } : { label: "Resolvida", tone: "neutral" };
  }
}

/** Nome exibido: Instagram mostra o @ do perfil. */
export function displayName(contact: ConversationSummary["contact"]) {
  return contact.handle ?? contact.name;
}

export const formatAudioDuration = formatDuration;

export function previewText(last: ConversationSummary["lastMessage"]) {
  const prefix = last.direction === "out" ? "Você: " : "";
  switch (last.kind) {
    case "audio":
    case "document":
      return `${prefix}${mediaPreviewLabel({ kind: last.kind, fileName: last.fileName, durationSeconds: last.durationSeconds })}`;
    case "image":
      return `${prefix}${mediaPreviewLabel({ kind: "image", fileName: last.fileName, durationSeconds: null, caption: last.preview })}`;
    case "text":
      return last.preview;
  }
}

function dayKey(iso: string, timeZone: string) {
  return formatDate(iso, { year: "numeric", month: "2-digit", day: "2-digit" }, timeZone);
}

/** Separador do chat: "Hoje", "Ontem" ou "23 de out." */
export function dayLabel(iso: string, nowIso: string, timeZone: string) {
  const day = dayKey(iso, timeZone);
  if (day === dayKey(nowIso, timeZone)) return "Hoje";
  const yesterday = new Date(new Date(nowIso).getTime() - 86_400_000).toISOString();
  if (day === dayKey(yesterday, timeZone)) return "Ontem";
  return formatDate(iso, { day: "numeric", month: "short" }, timeZone);
}

export const sameDay = (a: string, b: string, timeZone: string) => dayKey(a, timeZone) === dayKey(b, timeZone);

export const timeOf = (iso: string, timeZone: string) => formatDate(iso, { hour: "2-digit", minute: "2-digit" }, timeZone);

/** Lista: hora se for hoje, "Ontem", ou dia/mês. */
export function listTime(iso: string, nowIso: string, timeZone: string) {
  const label = dayLabel(iso, nowIso, timeZone);
  if (label === "Hoje") return timeOf(iso, timeZone);
  if (label === "Ontem") return "Ontem";
  return formatDate(iso, { day: "2-digit", month: "2-digit" }, timeZone);
}

/** "há 4 min", "há 1 h 20", "ontem" */
export function relativeAgo(iso: string, nowIso: string, timeZone: string) {
  const minutes = Math.max(0, Math.round((new Date(nowIso).getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && sameDay(iso, nowIso, timeZone)) {
    const rest = minutes % 60;
    return rest ? `há ${hours} h ${rest}` : `há ${hours} h`;
  }
  return dayLabel(iso, nowIso, timeZone) === "Ontem" ? "ontem" : formatDate(iso, { day: "2-digit", month: "2-digit" }, timeZone);
}

/** "Hoje às 16:10", "Amanhã às 10:00", "Qui, 29/10 às 09:00" */
export function whenLabel(iso: string, nowIso: string, timeZone: string) {
  const time = timeOf(iso, timeZone);
  const today = dayKey(nowIso, timeZone);
  const tomorrow = dayKey(new Date(new Date(nowIso).getTime() + 86_400_000).toISOString(), timeZone);
  const day = dayKey(iso, timeZone);
  if (day === today) return `Hoje às ${time}`;
  if (day === tomorrow) return `Amanhã às ${time}`;
  const weekday = formatDate(iso, { weekday: "short" }, timeZone).replace(".", "");
  const date = formatDate(iso, { day: "2-digit", month: "2-digit" }, timeZone);
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${date} às ${time}`;
}

/** Follow-up: "em 2 h", "em 35 min", "amanhã às 10:00" */
export function followUpLabel(iso: string, nowIso: string, timeZone: string) {
  const minutes = Math.round((new Date(iso).getTime() - new Date(nowIso).getTime()) / 60_000);
  if (minutes <= 0) return "agora";
  if (minutes < 60) return `em ${minutes} min`;
  if (minutes < 6 * 60 && sameDay(iso, nowIso, timeZone)) return `em ${Math.round(minutes / 60)} h`;
  return whenLabel(iso, nowIso, timeZone).replace("Hoje", "hoje").replace("Amanhã", "amanhã");
}

export function formatBytes(bytes: number | null) {
  return bytes === null ? "" : formatFileSize(bytes);
}

export function stagesOf(lookups: InboxLookups) {
  return lookups.tags
    .filter((t): t is typeof t & { funnelStage: number } => t.funnelStage !== null)
    .sort((a, b) => a.funnelStage - b.funnelStage);
}

// ── datas no fuso da organização ────────────────────────────────────────────

/** "2026-10-26" no fuso informado. */
export function dateInZone(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function zoneOffset(timeZone: string, at: Date) {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return match ? `${match[1]}:${match[2] ?? "00"}` : "+00:00";
}

/** Dia "2026-10-27" + hora "09:00" no fuso da organização → ISO em UTC. */
export function zonedIso(date: string, time: string, timeZone: string) {
  const offset = zoneOffset(timeZone, new Date(`${date}T${time}:00Z`));
  return new Date(`${date}T${time}:00${offset}`).toISOString();
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── permissões (calculadas no server com `can(role, …)` e passadas às telas) ──

export type InboxPermissions = {
  reply: boolean;
  assign: boolean;
  transfer: boolean;
  viewAll: boolean;
  editContact: boolean;
  manageAppointments: boolean;
};

export const NO_PERMISSION_HINT = "Seu papel não permite esta ação. Fale com um administrador.";
