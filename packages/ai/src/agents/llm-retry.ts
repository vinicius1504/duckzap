import { LlmError } from "../llm";
import type { LlmRetryOptions } from "./types";

/** Esperas padrão antes da 1ª e da 2ª nova tentativa (ms). */
export const DEFAULT_RETRY_DELAYS_MS = [1_500, 4_000];
const DEFAULT_JITTER = 0.25;

/** Espera `ms`; se o `signal` abortar, resolve na hora (quem chamou confere `signal.aborted`). */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Espera com variação aleatória de ±`jitter` (ex.: 1500 ms ± 25%). */
export function backoffDelay(baseMs: number, jitter: number, random: () => number): number {
  const spread = baseMs * jitter;
  return Math.max(0, Math.round(baseMs - spread + random() * spread * 2));
}

export function isRetryableLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError && error.retryable;
}

/**
 * Executa `run` e, se falhar com `LlmError` repetível, tenta de novo conforme `options.delaysMs`. Erros que não são
 * repetíveis (auth, pedido inválido, recusa, falha desconhecida) sobem na hora. Esgotadas as tentativas, sobe o último erro.
 * Cada tentativa chama `run` de novo; quem contabiliza uso/orçamento faz isso só com o resultado de sucesso.
 */
export async function withLlmRetry<T>(run: () => Promise<T>, options: LlmRetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const base = delays[attempt];
      if (!isRetryableLlmError(error) || base === undefined || options.signal?.aborted) throw error;
      await sleep(backoffDelay(base, options.jitter ?? DEFAULT_JITTER, random), options.signal);
      if (options.signal?.aborted) throw error;
    }
  }
}
