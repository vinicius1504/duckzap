/** Resultado tipado das operações do painel (o que as Server Actions esperam de cada `api.ts`). */
export type Result<T, E extends string = string> =
  | { ok: true; data: T }
  | { ok: false; error: E; message: string };

export const ok = <T>(data: T): Result<T, never> => ({ ok: true, data });
export const fail = <E extends string>(error: E, message: string): Result<never, E> => ({
  ok: false,
  error,
  message,
});
