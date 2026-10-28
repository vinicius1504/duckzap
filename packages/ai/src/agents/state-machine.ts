import type { ConversationState } from "./types";

/**
 * Máquina de estados explícita por conversa (§4.1):
 * ai_active → waiting_customer → handoff_requested → human_active → resolved.
 * Cada transição devolve um registro de auditoria; quem persiste é o módulo Conversas/API.
 */
export type ConversationEvent =
  | "customer_message"
  | "ai_replied"
  | "handoff_requested"
  | "human_took_over"
  | "ai_resumed"
  | "resolved";

export type Actor = "customer" | "ai" | "human" | "system";

export type TransitionRecord = {
  from: ConversationState;
  to: ConversationState;
  event: ConversationEvent;
  actor: Actor;
  at: string;
  reason?: string;
  userId?: string;
};

const table: Record<ConversationState, Partial<Record<ConversationEvent, ConversationState>>> = {
  ai_active: {
    customer_message: "ai_active",
    ai_replied: "waiting_customer",
    handoff_requested: "handoff_requested",
    human_took_over: "human_active",
    resolved: "resolved",
  },
  waiting_customer: {
    customer_message: "ai_active",
    ai_replied: "waiting_customer",
    handoff_requested: "handoff_requested",
    human_took_over: "human_active",
    resolved: "resolved",
  },
  handoff_requested: {
    customer_message: "handoff_requested",
    human_took_over: "human_active",
    ai_resumed: "ai_active",
    resolved: "resolved",
  },
  human_active: {
    customer_message: "human_active",
    ai_resumed: "ai_active",
    resolved: "resolved",
  },
  // cliente que escreve numa conversa resolvida a reabre
  resolved: { customer_message: "ai_active" },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ConversationState,
    readonly event: ConversationEvent,
  ) {
    super(`Transição inválida: ${event} em ${from}.`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: ConversationState, event: ConversationEvent) {
  return table[from][event] !== undefined;
}

export function transition(
  from: ConversationState,
  event: ConversationEvent,
  meta: { actor: Actor; at?: Date; reason?: string; userId?: string },
): TransitionRecord {
  const to = table[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return {
    from,
    to,
    event,
    actor: meta.actor,
    at: (meta.at ?? new Date()).toISOString(),
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.userId ? { userId: meta.userId } : {}),
  };
}

/** A IA só responde nestes estados. */
export function aiMayRespond(state: ConversationState) {
  return state === "ai_active" || state === "waiting_customer" || state === "resolved";
}
