import type {
  ConversationMode,
  ConversationPriority,
  ConversationStatus,
  InboxTab,
  MessageStatus,
} from "@duckzap/contracts/conversations";
import type { ReplyMode } from "@duckzap/contracts/channels";
import type { BusinessHours as SettingsHours } from "@duckzap/contracts/settings";
import type { BusinessHours as AiHours } from "@duckzap/ai";
import { shiftDay, zonedToUtc } from "../appointments/time";
import { isExplicitOptOut } from "../contacts/consent";

// Regras PURAS do módulo Conversas (sem banco, sem Hono): visibilidade, abas, status monotônico, horário comercial,
// ordem do pipeline de entrada, rajada. Os services chamam estas funções; os testes unitários cobrem todas.

// ── visibilidade e abas ─────────────────────────────────────────────────────

export const OPEN_STATUSES: readonly ConversationStatus[] = ["ai_active", "handoff_requested", "human_active"];
export const isOpenStatus = (status: ConversationStatus) => OPEN_STATUSES.includes(status);

export type Viewer = { id: string; canViewAll: boolean; teamIds: ReadonlySet<string> };
export type VisibilityRow = { assigneeId: string | null; status: ConversationStatus; teamId: string | null };

/**
 * Quem não tem `conversation.view_all` só vê: o que é dela e as conversas sem responsável das suas equipes. A fila
 * (Aguardando) segue a mesma regra: fila de uma equipe é só dos membros dela; só a fila SEM equipe é de todos. Conversa
 * resolvida sem responsável não aparece. O SQL em `queries.ts` espelha esta função (os testes de integração conferem os
 * dois lados).
 */
export function isVisibleTo(row: VisibilityRow, viewer: Viewer): boolean {
  if (viewer.canViewAll || row.assigneeId === viewer.id) return true;
  if (row.assigneeId !== null || row.status === "resolved") return false;
  if (row.teamId === null) return row.status === "handoff_requested";
  return viewer.teamIds.has(row.teamId);
}

export function inTab(tab: InboxTab, row: VisibilityRow, viewer: Viewer): boolean {
  switch (tab) {
    case "mine":
      // só o que é da pessoa (assumiu ou recebeu por transferência); fila e IA têm as suas abas
      return isOpenStatus(row.status) && row.assigneeId === viewer.id;
    case "waiting":
      return row.status === "handoff_requested";
    case "ai":
      return row.status === "ai_active";
    case "all":
      return viewer.canViewAll && isOpenStatus(row.status);
    case "resolved":
      return row.status === "resolved";
  }
}

export const PRIORITY_RANK: Record<ConversationPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

// ── status de entrega (monotônico) ──────────────────────────────────────────

const STATUS_RANK: Record<MessageStatus, number> = { sending: 0, sent: 1, failed: 1, delivered: 2, read: 3 };

/**
 * Status que vale depois de um evento do provedor. `null` = ignorar (o status nunca anda para trás).
 * "failed" só vale se ainda não foi entregue; depois de falhar, só uma entrega/leitura de verdade o promove.
 */
export function nextMessageStatus(current: MessageStatus | null, incoming: "sent" | "delivered" | "read" | "failed"): MessageStatus | null {
  if (current === null) return null; // notas e mensagens recebidas não têm status
  if (incoming === "failed") return current === "sending" || current === "sent" ? "failed" : null;
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : null;
}

// ── horário comercial e mensagens automáticas ───────────────────────────────

/** Ajustes usa `day` 0 = domingo; a IA usa `days[0]` = domingo com janelas "HH:MM". */
export function toAiHours(hours: SettingsHours, timeZone: string): AiHours {
  const days: AiHours["days"] = [null, null, null, null, null, null, null];
  for (const d of hours) days[d.day] = d.open ? [d.start, d.end] : null;
  return { timeZone, days };
}

/**
 * Modo com que uma conversa NOVA nasce. Canal `auto` (sem IA): sempre "human" (fila da equipe), mesmo com agente ligado ao canal.
 * Canal `ai`: "ai" se há agente ativo, senão "human". Conversas que já existem não mudam.
 */
export function initialConversationMode(replyMode: ReplyMode, hasActiveAgent: boolean): ConversationMode {
  return replyMode === "ai" && hasActiveAgent ? "ai" : "human";
}

export type AutoMessage = "welcome" | "out_of_hours" | null;
export const OUT_OF_HOURS_NOTICE_COOLDOWN_MS = 12 * 3_600_000;

/**
 * Qual mensagem automática do canal enviar. No modo `ai` (Somente IA) NUNCA há mensagem automática: os textos ficam
 * guardados, mas quem cumprimenta e trata o horário é o agente. No modo `auto` vale o que segue. Fora do horário vale o aviso de "fora do horário" (no máximo um a cada 12 h);
 * dentro dele, só a boas-vindas e só na primeira mensagem de uma conversa nova. Nunca as duas juntas.
 */
export function decideAutoMessage(input: {
  replyMode: ReplyMode;
  isNewConversation: boolean;
  withinHours: boolean;
  welcome: string;
  outOfHours: string;
  outOfHoursNoticeAt: Date | null;
  now: Date;
}): AutoMessage {
  if (input.replyMode !== "auto") return null;
  if (!input.withinHours) {
    const recent = input.outOfHoursNoticeAt !== null && input.now.getTime() - input.outOfHoursNoticeAt.getTime() < OUT_OF_HOURS_NOTICE_COOLDOWN_MS;
    if (input.outOfHours.trim() && !recent) return "out_of_hours";
    return input.isNewConversation && !input.outOfHours.trim() && input.welcome.trim() ? "welcome" : null;
  }
  return input.isNewConversation && input.welcome.trim() ? "welcome" : null;
}

// ── pipeline de entrada (§3.3 / §5.7 item 7) ────────────────────────────────

/** Ordem em que o handler de mensagens recebidas trabalha. Opt-out vem antes de qualquer outra regra de negócio. */
export const INBOUND_STEPS = [
  "dedupe",
  "contact",
  "opt_out",
  "consent_reply",
  "conversation",
  "store_message",
  "bookkeeping",
  "auto_message",
  "reminder_reply",
  "ai",
] as const;
export type InboundStep = (typeof INBOUND_STEPS)[number];

const EXIT_WORDS = new Set(["sair", "sai", "saia", "parar", "pare", "cancelar", "cancela", "cancele", "descadastrar", "descadastra", "stop", "remover", "remova"]);
// palavras que podem acompanhar o pedido de saída sem mudar o sentido ("quero sair", "pode parar de mandar mensagem")
const EXIT_FILLER = new Set([
  "quero", "por", "favor", "pf", "pfv", "me", "de", "da", "do", "a", "o", "lista", "mensagem", "mensagens", "receber", "mais", "nao",
  "ja", "agora", "obrigado", "obrigada", "tire", "tira", "tirar", "pode", "mandar", "enviar", "envie", "manda", "vou", "ok",
]);

function plain(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "SAIR / PARAR / CANCELAR" (e variações curtas) = pedido de não receber mais mensagens. Mais estrita que a regra de
 * Clientes: só vale quando a mensagem é o pedido e nada além dele. "quero cancelar minha consulta" ou "posso parar na
 * recepção?" são atendimento, não saída.
 */
export function isOptOutMessage(text: string): boolean {
  if (!isExplicitOptOut(text)) return false;
  const words = plain(text).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  return words.some((w) => EXIT_WORDS.has(w)) && words.every((w) => EXIT_WORDS.has(w) || EXIT_FILLER.has(w));
}

export type InboundClassification = { optOut: boolean };

export function classifyInbound(text: string | undefined): InboundClassification {
  return { optOut: text !== undefined && isOptOutMessage(text) };
}

// ── status da conversa depois de uma mensagem do cliente ────────────────────

export type InboundStatusInput = { status: ConversationStatus; mode: ConversationMode; assigneeId: string | null };

/**
 * Para onde vai a conversa quando o cliente escreve. Modo IA com agente ativo: a IA atende (a menos que uma pessoa já
 * tenha assumido ou a fila já esteja esperando). Copiloto e Só humano: com responsável segue com ele; sem, entra na fila.
 */
export function statusAfterInbound(c: InboundStatusInput, hasActiveAgent: boolean): { status: ConversationStatus; queued: boolean } {
  if (c.mode === "ai" && hasActiveAgent) {
    if (c.status === "human_active" || c.status === "handoff_requested") return { status: c.status, queued: c.status === "handoff_requested" };
    return { status: "ai_active", queued: false };
  }
  if (c.status === "human_active") return { status: "human_active", queued: false };
  if (c.assigneeId !== null) return { status: "human_active", queued: false };
  return { status: "handoff_requested", queued: true };
}

/** A IA só cuida de uma mensagem nova quando o modo é IA, há agente ativo e a conversa está com ela. */
export function shouldRunAi(c: { mode: ConversationMode; status: ConversationStatus }, hasActiveAgent: boolean): "live" | "copilot" | null {
  if (!hasActiveAgent) return null;
  if (c.mode === "ai" && c.status === "ai_active") return "live";
  if (c.mode === "copilot" && c.status !== "resolved") return "copilot";
  return null;
}

// ── rajada (§4.1) ───────────────────────────────────────────────────────────

/**
 * Prazo da resposta da IA. Cada mensagem nova empurra o prazo em `windowMs`, mas nunca além de `maxWaitMs` contados do
 * início da rajada (quem digita sem parar não atrasa a resposta para sempre). Uma rajada velha demais começa outra.
 */
export function computeAiDue(input: { now: Date; burstStartedAt: Date | null; windowMs: number; maxWaitMs: number }) {
  const nowMs = input.now.getTime();
  const stale = input.burstStartedAt === null || nowMs - input.burstStartedAt.getTime() > input.maxWaitMs + input.windowMs;
  const startedAt = stale ? input.now : (input.burstStartedAt as Date);
  const dueMs = Math.max(nowMs, Math.min(nowMs + input.windowMs, startedAt.getTime() + input.maxWaitMs));
  return { startedAt, dueAt: new Date(dueMs) };
}

/** Mensagens seguidas da IA depois da última do cliente (a IA só pode mandar até o limite do agente). */
export function trailingAgentCount(history: readonly { role: "customer" | "agent" | "human" }[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const role = history[i]?.role;
    if (role === "agent") n++;
    else break;
  }
  return n;
}

// ── última mensagem (lista do inbox) ────────────────────────────────────────

export type LastMessageKind = "text" | "audio" | "image" | "document";

export function lastMessageKindOf(kind: string): LastMessageKind {
  return kind === "audio" || kind === "image" || kind === "document" ? kind : "text";
}

/** Texto curto para a lista; mídia sem legenda fica vazia (a tela mostra o ícone). */
export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

/** Texto que a IA enxerga no lugar de uma mídia (ela não lê arquivos). */
export function aiTextFor(kind: string, body: string): string {
  if (body.trim()) return body;
  switch (kind) {
    case "audio":
      return "[o cliente enviou um áudio]";
    case "image":
      return "[o cliente enviou uma imagem]";
    case "document":
      return "[o cliente enviou um documento]";
    default:
      return "";
  }
}

// ── busca ───────────────────────────────────────────────────────────────────

/** Escapa `%`, `_` e `\` para usar a busca do cliente dentro de um ILIKE. */
export function likePattern(search: string): string {
  return `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ── horários livres para a IA (agenda) ──────────────────────────────────────


export const SLOT_STEP_MINUTES = 30;
export const SLOT_MIN_LEAD_MINUTES = 60;
export const SLOT_MAX_DAYS = 14;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `slot:<tipo>:<instante UTC sem milissegundos>`: o id carrega o horário, então não há tabela de "slots" para vazar. */
export function slotId(typeId: string, startsAt: Date) {
  return `slot:${typeId}:${startsAt.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

export function parseSlotId(id: string, typeId: string): Date | null {
  const prefix = `slot:${typeId}:`;
  if (!id.startsWith(prefix)) return null;
  const at = new Date(id.slice(prefix.length));
  return Number.isNaN(at.getTime()) ? null : at;
}

export type BusyRange = { start: Date; end: Date };

/**
 * Horários livres de um tipo de atendimento: dentro do horário comercial, de 30 em 30 min, com antecedência mínima,
 * sem bater com agendamentos do responsável. Só a IA os oferece; ao marcar, o servidor confere de novo.
 */
export function generateSlots(input: {
  fromDay: string;
  toDay: string;
  hours: SettingsHours;
  timeZone: string;
  durationMinutes: number;
  busy: readonly BusyRange[];
  now: Date;
  max?: number;
}): Date[] {
  if (!DAY_RE.test(input.fromDay) || !DAY_RE.test(input.toDay) || input.toDay < input.fromDay) return [];
  const out: Date[] = [];
  const earliest = input.now.getTime() + SLOT_MIN_LEAD_MINUTES * 60_000;
  const max = input.max ?? 40;
  let day = input.fromDay;
  for (let i = 0; i < SLOT_MAX_DAYS && day <= input.toDay && out.length < max; i++, day = shiftDay(day, 1)) {
    const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const window = input.hours.find((h) => h.day === weekday);
    if (!window?.open) continue;
    const [sh = 0, sm = 0] = window.start.split(":").map(Number);
    const [eh = 0, em = 0] = window.end.split(":").map(Number);
    for (let minute = sh * 60 + sm; minute + input.durationMinutes <= eh * 60 + em && out.length < max; minute += SLOT_STEP_MINUTES) {
      const hh = String(Math.floor(minute / 60)).padStart(2, "0");
      const mm = String(minute % 60).padStart(2, "0");
      const start = new Date(zonedToUtc(day, `${hh}:${mm}`, input.timeZone));
      const end = new Date(start.getTime() + input.durationMinutes * 60_000);
      if (start.getTime() < earliest) continue;
      if (input.busy.some((b) => b.start < end && start < b.end)) continue;
      out.push(start);
    }
  }
  return out;
}
