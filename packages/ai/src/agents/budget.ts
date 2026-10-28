/**
 * Custos (§4.3): orçamento de tokens por organização/plano e limite de turnos por conversa.
 * Funções puras; o módulo agents soma `ai_usage_log` do mês e passa `used` aqui.
 */

/**
 * Valores iniciais do teto mensal de tokens (entrada + saída) dos planos de catálogo, usados só no seed e em testes.
 * A fonte de verdade em execução é `plans.monthly_token_limit` (null = ilimitado). [A DEFINIR] pelo negócio.
 */
export const PLAN_MONTHLY_TOKEN_LIMIT = {
  basico: 1_500_000,
  pro: 8_000_000,
  empresarial: 30_000_000,
} as const;

export type BudgetStatus = { limit: number; used: number; remaining: number; exceeded: boolean; nearLimit: boolean };

/** `limit` vem do plano da empresa (`plans.monthly_token_limit`; use um número enorme para ilimitado). */
export function tokenBudget(usedTokens: number, limit: number): BudgetStatus {
  const remaining = Math.max(0, limit - usedTokens);
  return { limit, used: usedTokens, remaining, exceeded: remaining <= 0, nearLimit: usedTokens >= limit * 0.8 };
}

/** Estimativa grosseira (pt-BR ≈ 3,5 caracteres por token) para decidir ANTES de chamar o modelo. */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 3.5);
}

/** Limite de turnos de IA por conversa numa janela deslizante (anti-loop e anti-abuso). */
export function createConversationRateLimiter(options: { max: number; windowMs: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    /** true = pode responder (e registra o turno). */
    allow(conversationId: string) {
      const t = now();
      const recent = (hits.get(conversationId) ?? []).filter((h) => t - h < options.windowMs);
      if (recent.length >= options.max) {
        hits.set(conversationId, recent);
        return false;
      }
      recent.push(t);
      hits.set(conversationId, recent);
      return true;
    },
  };
}
