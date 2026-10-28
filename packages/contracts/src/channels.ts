import { z } from "zod";

/** QR Code (provedor não oficial, ex.: Evolution), API oficial (Meta Cloud) ou Instagram. */
export const channelTypeSchema = z.enum(["whatsapp_qr", "whatsapp_official", "instagram"]);
export type ChannelType = z.infer<typeof channelTypeSchema>;

/**
 * Status normalizado (§3.6): connected | qr_pending | disconnected | banned.
 * `awaiting_authorization` cobre o Instagram antes do OAuth (não há QR nesse caso).
 */
export const channelStatusSchema = z.enum(["connected", "qr_pending", "awaiting_authorization", "disconnected", "banned"]);
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const inactivityTransferMinutesSchema = z.union([z.literal(10), z.literal(30), z.literal(60)]);
export type InactivityTransferMinutes = z.infer<typeof inactivityTransferMinutesSchema>;

/**
 * Como o canal responde:
 * - `ai`: somente a IA (padrão). As mensagens de boas-vindas e fora do horário ficam guardadas, mas não são enviadas.
 * - `auto`: automático, sem IA. O sistema envia as mensagens automáticas e conversas novas entram na fila da equipe.
 */
export const replyModeSchema = z.enum(["ai", "auto"]);
export type ReplyMode = z.infer<typeof replyModeSchema>;

export const channelMessagesSchema = z.object({
  welcome: z.string().max(1000),
  outOfHours: z.string().max(1000),
  closing: z.string().max(1000),
  rating: z.string().max(1000),
});
export type ChannelMessages = z.infer<typeof channelMessagesSchema>;

export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: channelTypeSchema,
  status: channelStatusSchema,
  /** E.164 para WhatsApp; @usuario para Instagram; null enquanto não conectou. */
  address: z.string().nullable(),
  isDefault: z.boolean(),
  teamId: z.string().nullable(),
  agentId: z.string().nullable(),
  replyMode: replyModeSchema,
  /** Mensagens de pessoa saem com o nome de quem atende (`*Rafael (Vendas):*`). Padrão ligado; a IA nunca assina. */
  signMessages: z.boolean(),
  messages: channelMessagesSchema,
  /** Sem resposta do cliente por N min → conversa vai para a fila da equipe. */
  inactivityTransferMinutes: inactivityTransferMinutesSchema,
  createdAt: z.iso.datetime(),
  lastStatusChangeAt: z.iso.datetime(),
});
export type Channel = z.infer<typeof channelSchema>;

export const linkOptionSchema = z.object({ id: z.string(), name: z.string() });
export type LinkOption = z.infer<typeof linkOptionSchema>;

export const channelsOverviewSchema = z.object({
  channels: z.array(channelSchema),
  teams: z.array(linkOptionSchema),
  agents: z.array(linkOptionSchema),
  limit: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
  /** Tipos que o plano permite criar (§1.2: Instagram só no Escala). */
  allowedTypes: z.array(channelTypeSchema),
});
export type ChannelsOverview = z.infer<typeof channelsOverviewSchema>;

export const createChannelInputSchema = z.object({
  type: channelTypeSchema,
  name: z.string().trim().min(2, "Dê um nome com pelo menos 2 letras.").max(40, "Use até 40 caracteres."),
});
export type CreateChannelInput = z.infer<typeof createChannelInputSchema>;

export const updateChannelSettingsInputSchema = z.object({
  teamId: z.string().nullable(),
  agentId: z.string().nullable(),
  /** Ausente = mantém o modo atual. Trocar para `ai` não apaga os textos: só deixam de ser enviados. */
  replyMode: replyModeSchema.optional(),
  /** Ausente = mantém. */
  signMessages: z.boolean().optional(),
  messages: channelMessagesSchema,
  inactivityTransferMinutes: inactivityTransferMinutesSchema,
});
export type UpdateChannelSettingsInput = z.infer<typeof updateChannelSettingsInputSchema>;

/** Sessão de QR do provedor não oficial. O código expira e é renovado. */
export const qrSessionSchema = z.object({
  channelId: z.string(),
  status: z.enum(["waiting", "connected", "expired"]),
  /** Conteúdo do QR (o provedor devolve a string; a tela desenha). */
  payload: z.string(),
  expiresAt: z.iso.datetime(),
});
export type QrSession = z.infer<typeof qrSessionSchema>;

export const officialCredentialsInputSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{10,20}$/, "O ID do número tem só dígitos (10 a 20)."),
  businessAccountId: z.string().trim().regex(/^\d{10,20}$/, "O ID da conta tem só dígitos (10 a 20)."),
  accessToken: z.string().trim().min(20, "Cole o token de acesso completo."),
  /** Segredo do app Meta (valida a assinatura dos webhooks). Opcional: sem ele vale o segredo do app da plataforma. */
  appSecret: z.string().trim().min(16, "Cole o segredo do app completo.").max(256).optional(),
});
export type OfficialCredentialsInput = z.infer<typeof officialCredentialsInputSchema>;

/** Dados que a Meta pede para configurar o webhook do número oficial. */
export const officialWebhookInfoSchema = z.object({ webhookUrl: z.url(), verifyToken: z.string() });
export type OfficialWebhookInfo = z.infer<typeof officialWebhookInfoSchema>;

/** Troca do token secreto da URL do webhook. `webhookUrl` só vem para a API oficial (a Meta precisa da URL nova). */
export const rotateWebhookTokenResultSchema = z.object({ webhookUrl: z.url().nullable() });
export type RotateWebhookTokenResult = z.infer<typeof rotateWebhookTokenResultSchema>;

/** Atribuição de canais a uma equipe (usado por Equipe). */
export const assignTeamChannelsInputSchema = z.object({
  teamId: z.string().min(1).max(64),
  channelIds: z.array(z.string().min(1).max(64)).max(100),
});
export type AssignTeamChannelsInput = z.infer<typeof assignTeamChannelsInputSchema>;
