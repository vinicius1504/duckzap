import type { InboundEvent } from "./messaging";

/**
 * Despacho de eventos recebidos dos provedores (§3.3). O módulo Canais valida e grava o evento bruto
 * (idempotente) e chama `dispatchInbound`; o módulo Conversas registra o handler que resolve contato,
 * conversa e modo (IA / copiloto / humano). Assim os dois módulos não se importam diretamente.
 */
export type InboundContext = { organizationId: string; channelId: string; event: InboundEvent };
export type InboundHandler = (context: InboundContext) => Promise<void>;

const handlers: InboundHandler[] = [];

export function registerInboundHandler(handler: InboundHandler) {
  handlers.push(handler);
}

/** Sem handler registrado (módulo Conversas ainda não carregado), mensagens ficam pendentes em vez de "processadas". */
export function hasInboundHandlers() {
  return handlers.length > 0;
}

export async function dispatchInbound(context: InboundContext) {
  for (const handler of handlers) await handler(context);
}
