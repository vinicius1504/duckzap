import { MAX_TYPING_MS, type InboundPresence } from "./messaging";

/**
 * "Digitando…" (presença) entre os módulos. Dois assuntos, ambos efêmeros e sem gravar nada:
 *  - ENTRADA: o módulo Canais recebe `presence.update` do provedor e chama `dispatchPresence`; o módulo Conversas registra
 *    o handler que acha a conversa aberta do contato e avisa a tela em tempo real. (Mesmo desacoplamento de `lib/inbound.ts`,
 *    mas SEM idempotência, SEM `inbound_events` e SEM reprocessamento: perder um aviso de presença é inofensivo.)
 *  - SAÍDA: duração do "digitando…" proporcional ao texto (`typingMsForText`), usada pela IA e pelas campanhas.
 */
export type PresenceContext = { organizationId: string; channelId: string; from: string; presence: InboundPresence };
export type PresenceHandler = (context: PresenceContext) => Promise<void>;

const handlers: PresenceHandler[] = [];

export function registerPresenceHandler(handler: PresenceHandler) {
  handlers.push(handler);
}

/** Nunca lança: presença é melhor esforço e jamais pode derrubar o webhook. */
export async function dispatchPresence(context: PresenceContext): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(context);
    } catch {
      // ignorado de propósito (sem log com telefone)
    }
  }
}

/** Testes: remove os handlers registrados. */
export function clearPresenceHandlers() {
  handlers.length = 0;
}

export const TYPING_MS_PER_CHAR = 35;
export const TYPING_MS_MIN = 800;
export const TYPING_MS_MAX = 6_000;

/**
 * Quanto tempo mostrar "digitando…" antes de entregar uma resposta automática: ~35 ms por caractere, no mínimo 800 ms e no
 * máximo 6 s (sempre abaixo de `MAX_TYPING_MS`). Texto vazio = 0 (nada a mostrar).
 */
export function typingMsForText(text: string): number {
  const length = text.trim().length;
  if (length === 0) return 0;
  const ms = Math.round(length * TYPING_MS_PER_CHAR);
  return Math.min(TYPING_MS_MAX, MAX_TYPING_MS, Math.max(TYPING_MS_MIN, ms));
}
