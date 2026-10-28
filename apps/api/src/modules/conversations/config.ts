import { z } from "zod";

/** Variáveis do módulo Conversas (lidas aqui, sem mexer em src/env.ts). Documentadas em apps/api/.env.example. */
const schema = z.object({
  /** Espera (ms) por novas mensagens do cliente antes de a IA responder (rajada, §4.1). 0 = responde na hora (testes). */
  CONVERSATIONS_BURST_WINDOW_MS: z.coerce.number().int().min(0).max(30_000).default(5000),
  /** Teto (ms) da espera, contado do início da rajada. */
  CONVERSATIONS_BURST_MAX_WAIT_MS: z.coerce.number().int().min(0).max(60_000).default(15_000),
  /** Turnos de IA por conversa por minuto (anti-loop). */
  CONVERSATIONS_AI_TURNS_PER_MINUTE: z.coerce.number().int().positive().default(12),
  /** Sugestões do Copiloto pedidas à mão, por pessoa por minuto. */
  CONVERSATIONS_SUGGESTIONS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  /** Varredura das respostas de IA vencidas e do encerramento por inatividade (ms). 0 = desligada. */
  CONVERSATIONS_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  /** Cliente que escreve depois de resolvida há até N dias reabre a mesma conversa; depois, abre outra. */
  CONVERSATIONS_REOPEN_WINDOW_DAYS: z.coerce.number().int().min(0).max(90).default(7),
});

export type ConversationsConfig = z.infer<typeof schema>;

export function loadConversationsConfig(source: NodeJS.ProcessEnv = process.env): ConversationsConfig {
  return schema.parse(source);
}
