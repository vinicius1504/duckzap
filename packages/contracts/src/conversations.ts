import { z } from "zod";

// Conversas (inbox omnichannel). Nomes de domínio em inglês; nada visual aqui (a tela mapeia tom e texto).

// ── Catálogos usados pelo inbox ─────────────────────────────────────────────

export const channelKindSchema = z.enum(["whatsapp_qr", "whatsapp_api", "instagram"]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

export const inboxChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: channelKindSchema,
  status: z.enum(["connected", "disconnected"]),
});
export type InboxChannel = z.infer<typeof inboxChannelSchema>;

export const inboxTeamSchema = z.object({ id: z.string(), name: z.string() });
export type InboxTeam = z.infer<typeof inboxTeamSchema>;

export const inboxMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamIds: z.array(z.string()),
  online: z.boolean(),
});
export type InboxMember = z.infer<typeof inboxMemberSchema>;

export const inboxAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  job: z.enum(["support", "follow_up", "scheduling", "instagram_dm", "comments"]),
});
export type InboxAgent = z.infer<typeof inboxAgentSchema>;

/** Etiqueta. As 4 primeiras (com `funnelStage` 1–4) são as etapas do funil. */
export const inboxTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  funnelStage: z.number().int().min(1).nullable(),
});
export type InboxTag = z.infer<typeof inboxTagSchema>;

export const quickReplySchema = z.object({
  id: z.string(),
  /** sem a barra: "horarios" → digitado como "/horarios" */
  shortcut: z.string().regex(/^[a-z0-9_-]+$/),
  title: z.string(),
  body: z.string(),
});
export type QuickReply = z.infer<typeof quickReplySchema>;

export const inboxLookupsSchema = z.object({
  channels: z.array(inboxChannelSchema),
  teams: z.array(inboxTeamSchema),
  members: z.array(inboxMemberSchema),
  agents: z.array(inboxAgentSchema),
  tags: z.array(inboxTagSchema),
  quickReplies: z.array(quickReplySchema),
  appointmentTypes: z.array(z.object({ id: z.string(), name: z.string(), durationMinutes: z.number().int() })),
  /** profissionais que atendem (Agenda) */
  professionals: z.array(z.string()),
});
export type InboxLookups = z.infer<typeof inboxLookupsSchema>;

// ── Conversa ────────────────────────────────────────────────────────────────

/** Máquina de estados do orquestrador (§4.1), simplificada para o inbox. */
export const conversationStatusSchema = z.enum(["ai_active", "handoff_requested", "human_active", "resolved"]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

/** Quem responde: IA sozinha, IA sugere (copiloto) ou só a equipe. */
export const conversationModeSchema = z.enum(["ai", "copilot", "human"]);
export type ConversationMode = z.infer<typeof conversationModeSchema>;

export const conversationPrioritySchema = z.enum(["urgent", "high", "normal", "low"]);
export type ConversationPriority = z.infer<typeof conversationPrioritySchema>;

export const followUpSchema = z.object({
  scheduledAt: z.iso.datetime(),
  paused: z.boolean(),
  /** agente que envia o follow-up */
  agentId: z.string(),
});
export type FollowUp = z.infer<typeof followUpSchema>;

export const conversationContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** WhatsApp: E.164. Instagram: null. */
  phone: z.string().nullable(),
  /** Instagram: "lucas.prado" (sem @). */
  handle: z.string().nullable(),
});
export type ConversationContact = z.infer<typeof conversationContactSchema>;

export const conversationSummarySchema = z.object({
  id: z.string(),
  contact: conversationContactSchema,
  /** null = canal apagado (a conversa continua salva e envia pelo canal padrão conectado). */
  channelId: z.string().nullable(),
  teamId: z.string().nullable(),
  assigneeId: z.string().nullable(),
  /** agente de IA que atende quando o modo permite */
  agentId: z.string().nullable(),
  status: conversationStatusSchema,
  mode: conversationModeSchema,
  priority: conversationPrioritySchema,
  /** etiqueta-etapa do funil */
  stageId: z.string(),
  tagIds: z.array(z.string()),
  resolvedBy: z.enum(["ai", "human"]).nullable(),
  lastMessage: z.object({
    /** texto da última mensagem (vazio para mídia sem legenda) */
    preview: z.string(),
    kind: z.enum(["text", "audio", "image", "document"]),
    fileName: z.string().nullable(),
    durationSeconds: z.number().int().nullable(),
    at: z.iso.datetime(),
    direction: z.enum(["in", "out"]),
  }),
  unreadCount: z.number().int().min(0),
  /** desde quando espera uma pessoa (fila) */
  waitingSince: z.iso.datetime().nullable(),
  followUp: followUpSchema.nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

// ── Mensagens ───────────────────────────────────────────────────────────────

export const messageStatusSchema = z.enum(["sending", "sent", "delivered", "read", "failed"]);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageAuthorSchema = z.object({
  kind: z.enum(["contact", "member", "agent", "system"]),
  id: z.string().nullable(),
  name: z.string(),
});
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

export const messageAttachmentSchema = z.object({
  fileName: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nullable(),
  durationSeconds: z.number().int().nullable(),
  /**
   * Leitura: URL ASSINADA e curta do arquivo (null se o arquivo ainda não foi baixado/guardado ou foi apagado).
   * Envio: ignorada pela API; o que vale é `mediaId`.
   */
  url: z.string().nullable(),
  /** Leitura, só imagem: URL assinada da miniatura leve (null/ausente = usar `url`). */
  thumbnailUrl: z.string().nullable().optional(),
  /** Figurinha recebida: a tela a mostra pequena, sem balão de imagem. */
  sticker: z.boolean().optional(),
  /** Envio: id devolvido por `POST /v1/media/uploads/{id}/complete` (ver contracts/media.ts). */
  mediaId: z.string().nullable().optional(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

/**
 * Item da linha do tempo. `note` é nota interna (só a equipe vê) e `event`
 * é um aviso do sistema (transferência, troca de modo, entrada na fila).
 */
export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["text", "audio", "image", "document", "note", "event"]),
  direction: z.enum(["in", "out", "internal"]),
  author: messageAuthorSchema,
  body: z.string(),
  attachment: messageAttachmentSchema.nullable(),
  /** só para mensagens de saída; null nas recebidas, notas e eventos */
  status: messageStatusSchema.nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;

// ── Painel do cliente ───────────────────────────────────────────────────────

export const contactAppointmentSchema = z.object({
  id: z.string(),
  startsAt: z.iso.datetime(),
  typeName: z.string(),
  professional: z.string(),
  status: z.enum(["pending", "confirmed", "reschedule", "done", "canceled"]),
});
export type ContactAppointment = z.infer<typeof contactAppointmentSchema>;

export const contactTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueAt: z.iso.datetime().nullable(),
  done: z.boolean(),
});
export type ContactTask = z.infer<typeof contactTaskSchema>;

export const contactProfileSchema = conversationContactSchema.extend({
  email: z.email().nullable(),
  isCustomer: z.boolean(),
  consent: z.enum(["pending", "granted", "denied", "expired"]),
  notes: z.string(),
  appointments: z.array(contactAppointmentSchema),
  tasks: z.array(contactTaskSchema),
  history: z.array(z.object({ id: z.string(), title: z.string(), at: z.iso.datetime() })),
});
export type ContactProfile = z.infer<typeof contactProfileSchema>;

export const conversationDetailSchema = z.object({
  conversation: conversationSummarySchema,
  messages: z.array(messageSchema),
  contact: contactProfileSchema,
});
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

// ── Lista e filtros ─────────────────────────────────────────────────────────

// "ai" = a IA está atendendo (aba IA). "all" não é aba da tela: só alimenta o quadro (Kanban) de quem vê tudo.
export const inboxTabSchema = z.enum(["mine", "waiting", "ai", "all", "resolved"]);
export type InboxTab = z.infer<typeof inboxTabSchema>;

export const inboxFiltersSchema = z.object({
  tab: inboxTabSchema,
  channelId: z.string().nullable(),
  teamId: z.string().nullable(),
  tagId: z.string().nullable(),
  priority: conversationPrioritySchema.nullable(),
  search: z.string().max(100).nullable(),
});
export type InboxFilters = z.infer<typeof inboxFiltersSchema>;

export const conversationListSchema = z.object({
  items: z.array(conversationSummarySchema),
  /** contagem por aba, já com os filtros aplicados (menos a aba) */
  counts: z.record(inboxTabSchema, z.number().int()),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

// ── Entradas das mutações ───────────────────────────────────────────────────

export const sendMessageInputSchema = z.object({
  conversationId: z.string(),
  kind: z.enum(["text", "audio", "image", "document", "note"]),
  body: z.string().max(4096),
  attachment: messageAttachmentSchema.nullable(),
  /** id temporário gerado no cliente (deduplicação do otimista) */
  clientId: z.string().max(64),
});
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const transferTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), memberId: z.string() }),
  z.object({ kind: z.literal("team"), teamId: z.string() }),
]);
export type TransferTarget = z.infer<typeof transferTargetSchema>;

export const scheduleAppointmentInputSchema = z.object({
  conversationId: z.string(),
  appointmentTypeId: z.string(),
  startsAt: z.iso.datetime(),
  professional: z.string().min(1).max(80),
});
export type ScheduleAppointmentInput = z.infer<typeof scheduleAppointmentInputSchema>;

export const replySuggestionSchema = z.object({ id: z.string(), body: z.string() });
export type ReplySuggestion = z.infer<typeof replySuggestionSchema>;

export const suggestionRatingSchema = z.enum(["useful", "bad"]);
export type SuggestionRating = z.infer<typeof suggestionRatingSchema>;
