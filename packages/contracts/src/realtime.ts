import { z } from "zod";

/**
 * Tempo real (WebSocket). Contrato único entre quem publica (API), o servidor `apps/realtime` e o front.
 *
 * Princípio de segurança: os eventos são AVISOS ("algo mudou"), só com ids. Nunca levam texto de mensagem,
 * nome ou telefone. Ao receber, o front busca o dado pela API normal, que aplica permissão e visibilidade
 * (ex.: atendente sem `conversation.view_all` não enxerga conversa de outra pessoa). Assim um evento nunca vaza conteúdo.
 *
 * Isolamento: cada evento pertence a UMA empresa e só é entregue a conexões dessa empresa.
 * Canal Redis/Valkey de publicação: `rt:org:<organizationId>` (ver `realtimeChannel`).
 */

export const realtimeEventSchema = z.discriminatedUnion("type", [
  /** Chegou ou saiu uma mensagem (inclui nota interna e evento de sistema). */
  z.object({ type: z.literal("conversation.message"), conversationId: z.string(), direction: z.enum(["in", "out", "internal"]) }),
  /** A conversa mudou (assumida, transferida, modo, resolvida, reaberta, etapa, lida, fila…). */
  z.object({
    type: z.literal("conversation.updated"),
    conversationId: z.string(),
    reason: z.enum(["assigned", "transferred", "mode", "resolved", "reopened", "stage", "read", "handoff", "queue", "follow_up", "other"]),
  }),
  /** Status de entrega de uma mensagem (enviada, entregue, lida, falhou). */
  z.object({
    type: z.literal("message.status"),
    conversationId: z.string(),
    messageId: z.string(),
    status: z.enum(["sending", "sent", "delivered", "read", "failed"]),
  }),
  /** Canal conectou, desconectou, pediu QR… */
  z.object({ type: z.literal("channel.status"), channelId: z.string(), status: z.string() }),
  /** Os números do Início podem ter mudado (tarefa, fila, agendamento). */
  z.object({ type: z.literal("home.invalidate") }),
  /** Há notificação nova para alguém da empresa: cada sino busca as suas pela API (o evento não diz de quem nem do quê). */
  z.object({ type: z.literal("notifications.invalidate") }),
  /** Alguém está digitando (contato ou agente). Efêmero: não é gravado. */
  z.object({ type: z.literal("typing"), conversationId: z.string(), actor: z.enum(["contact", "agent"]), active: z.boolean() }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/** O que a API publica no Valkey (um JSON por mensagem). */
export const realtimeEnvelopeSchema = z.object({
  v: z.literal(1),
  /** id para o front ignorar repetidos (reconexão, múltiplas instâncias) */
  id: z.string(),
  organizationId: z.string(),
  at: z.iso.datetime(),
  event: realtimeEventSchema,
});
export type RealtimeEnvelope = z.infer<typeof realtimeEnvelopeSchema>;

export const realtimeChannel = (organizationId: string) => `rt:org:${organizationId}`;

/** Servidor → navegador. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("event"), id: z.string(), at: z.iso.datetime(), event: realtimeEventSchema }),
  z.object({ type: z.literal("ping") }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Navegador → servidor. */
export const clientMessageSchema = z.discriminatedUnion("type", [z.object({ type: z.literal("pong") })]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Códigos de fechamento da conexão (WebSocket close codes 4000+). */
export const realtimeCloseCodes = {
  unauthorized: 4401,
  forbiddenOrigin: 4403,
  suspended: 4402,
  serverShuttingDown: 4503,
} as const;
