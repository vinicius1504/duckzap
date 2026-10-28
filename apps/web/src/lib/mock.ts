import "server-only";

/**
 * Utilitários da fase de dados de exemplo. Só os arquivos `features/<módulo>/api.ts`
 * usam isto; quando o módulo for ligado à API, o import some junto com o mock.
 */

/** Simula a latência da rede para os estados de carregamento aparecerem. */
export function mockDelay(ms = 200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ids previsíveis para itens criados durante a sessão de dev. */
export function mockId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type Result<T, E extends string = string> = { ok: true; data: T } | { ok: false; error: E; message: string };

export const ok = <T,>(data: T): Result<T, never> => ({ ok: true, data });
export const fail = <E extends string>(error: E, message: string): Result<never, E> => ({ ok: false, error, message });
