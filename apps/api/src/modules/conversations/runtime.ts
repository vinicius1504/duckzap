import type { Deps } from "../../lib/context";
import { registerInboundHandler } from "../../lib/inbound";
import { registerPresenceHandler } from "../../lib/presence";
import { getChannelsRuntime } from "../channels/runtime";
import { createAvatarPort, type AvatarPort } from "../contacts/avatar";
import { createInboundMediaPort, type InboundMediaPort } from "../media/inbound";
import { loadAgentsConfig } from "../agents/config";
import { createAiRateLimiters, runDueAiTurn, type AiDeps, type AiLimiters } from "./ai-turn";
import { loadConversationsConfig, type ConversationsConfig } from "./config";
import { registerConversationErasure } from "./erasure";
import { handleInbound, type InboundDeps } from "./inbound";
import { handleContactPresence } from "./presence";
import { createNumberCheckLimiter, type NumberCheckChannels, type NumberCheckDeps } from "./number-check";
import { createReadReceiptLimiter, type ReadReceiptChannels, type ReadReceiptDeps } from "./read-receipts";

export type ConversationsRuntime = {
  config: ConversationsConfig;
  inbound: InboundDeps;
  ai: AiDeps;
  limiters: AiLimiters;
  /** Visto azul no WhatsApp do cliente (equipe abriu a conversa / IA respondeu). */
  readReceipts: ReadReceiptDeps;
  /** Confere "tem WhatsApp?" antes de abrir uma conversa nova com o contato. */
  numberCheck: NumberCheckDeps;
};

export type RuntimeOverrides = {
  config?: ConversationsConfig;
  now?: () => Date;
  /** Substitui o temporizador do processo (testes chamam `runDueAiTurn` à mão; um worker usaria uma fila). */
  scheduleAiTurn?: InboundDeps["scheduleAiTurn"];
  /** Substitui o download da mídia recebida (testes). Padrão: provedor do canal + armazenamento configurado. */
  media?: InboundMediaPort;
  /** Substitui o runtime de canais usado para marcar como lida (testes injetam um provedor falso). Padrão: o do processo. */
  channels?: () => ReadReceiptChannels & NumberCheckChannels;
  /** Substitui a busca da foto de perfil (testes). Padrão: provedor do canal + armazenamento configurado, em segundo plano. */
  avatars?: AvatarPort;
  /** `false` nos testes: não registra o handler global nem a varredura. */
  register?: boolean;
};

const log = {
  warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ?? ""),
  error: (message: string, meta?: Record<string, unknown>) => console.error(message, meta ?? ""),
};

export function createConversationsRuntime(deps: Pick<Deps, "db" | "llm">, overrides: RuntimeOverrides = {}): ConversationsRuntime {
  const config = overrides.config ?? loadConversationsConfig();
  const limiters = createAiRateLimiters(config);
  const now = overrides.now ?? (() => new Date());
  const readReceipts: ReadReceiptDeps = { db: deps.db, channels: overrides.channels ?? getChannelsRuntime, limiter: createReadReceiptLimiter() };
  const numberCheck: NumberCheckDeps = { db: deps.db, channels: overrides.channels ?? getChannelsRuntime, limiter: createNumberCheckLimiter() };
  const ai: AiDeps = { db: deps.db, llm: deps.llm, config, urlAllowlist: loadAgentsConfig().AGENTS_URL_ALLOWLIST, now, log, readReceipts };
  const scheduleAiTurn: InboundDeps["scheduleAiTurn"] =
    overrides.scheduleAiTurn ??
    ((organizationId, conversationId, delayMs) => {
      // pequena folga: o temporizador nunca deve disparar antes do prazo gravado
      const timer = setTimeout(() => {
        void runDueAiTurn(ai, limiters, organizationId, conversationId).catch((error: unknown) =>
          log.error("conversations.ai.turn_failed", { conversationId, error: error instanceof Error ? error.name : "unknown" }),
        );
      }, delayMs + 50);
      timer.unref();
    });
  // turno adiado por falha passageira do provedor de IA: mesmo temporizador (o prazo gravado em ai_due_at é a fonte da verdade)
  ai.scheduleRetry = scheduleAiTurn;
  return { config, limiters, ai, readReceipts, numberCheck, inbound: { db: deps.db, config, scheduleAiTurn, media: overrides.media ?? createInboundMediaPort(), avatars: overrides.avatars ?? createAvatarPort({ db: deps.db, now }), now, log } };
}

// Um único handler no processo, sempre apontando para o runtime mais recente (várias instâncias do app em teste
// não duplicam o despacho). A varredura periódica (respostas vencidas, encerramento por inatividade) vive em
// `apps/api/src/jobs.ts` (`startBackgroundJobs`), junto das outras tarefas de fundo.
let current: ConversationsRuntime | null = null;
let handlerRegistered = false;

export function getConversationsRuntime(): ConversationsRuntime | null {
  return current;
}

export function activateConversations(runtime: ConversationsRuntime) {
  current = runtime;
  registerConversationErasure();
  if (!handlerRegistered) {
    handlerRegistered = true;
    registerInboundHandler(async (context) => {
      if (current) await handleInbound(current.inbound, context);
    });
    // "cliente digitando…": efêmero, só avisa a tela (nada é gravado)
    registerPresenceHandler(async (context) => {
      if (current) await handleContactPresence(current.inbound.db, context);
    });
  }
}
