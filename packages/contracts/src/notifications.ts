import { z } from "zod";

/**
 * Notificações do sino (topo do app). Cada notificação é de UMA pessoa (quem deve ficar sabendo) e fica guardada até ser lida.
 * O tempo real só avisa "há notificação nova" (evento `notifications.invalidate`, sem conteúdo): o sino busca a lista pela API,
 * que devolve apenas as da própria pessoa.
 */

export const notificationKindSchema = z.enum([
  /** A IA marcou um agendamento (já confirmado) numa conversa. */
  "appointment_booked",
  /** A IA remarcou um agendamento. */
  "appointment_rescheduled",
  /** A IA cancelou um agendamento a pedido do cliente. */
  "appointment_canceled",
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  kind: notificationKindSchema,
  /** Uma linha: "Jacan marcou um agendamento". */
  title: z.string(),
  /** "Maria Souza · Reunião de apresentação · quinta-feira, 29/10 às 08:30". */
  body: z.string(),
  /** Para onde ir ao clicar (rota do app, ex.: `/conversas?conversa=<id>`); null = não leva a lugar nenhum. */
  link: z.string().nullable(),
  createdAt: z.iso.datetime(),
  read: z.boolean(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const NOTIFICATIONS_PAGE = 30;

export const notificationListSchema = z.object({
  /** As mais novas primeiro (até `NOTIFICATIONS_PAGE`), lidas e não lidas. */
  items: z.array(notificationSchema),
  /** Total de não lidas da pessoa (pode ser maior que as listadas). */
  unreadCount: z.number().int().min(0),
});
export type NotificationList = z.infer<typeof notificationListSchema>;

/** `all: true` marca todas as da pessoa; ou uma lista de ids (só as dela são afetadas). */
export const markNotificationsReadSchema = z
  .object({ all: z.boolean().optional(), ids: z.array(z.string()).max(100).optional() })
  .refine((v) => v.all === true || (v.ids?.length ?? 0) > 0, "Informe all ou ids.");
export type MarkNotificationsRead = z.infer<typeof markNotificationsReadSchema>;
