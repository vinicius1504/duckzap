import { v7 } from "uuid";

/** Resultado tipado dos casos de uso: a rota traduz `error` em status HTTP; a tela mostra `message` (pt-BR). */
export type Ok<T> = { ok: true; data: T };
export type Fail<E extends string = string, X extends object = object> = { ok: false; error: E; message: string } & X;
export type Result<T, E extends string = string, X extends object = object> = Ok<T> | Fail<E, X>;

export const ok = <T>(data: T): Ok<T> => ({ ok: true, data });
export const fail = <E extends string>(error: E, message: string): Fail<E> => ({ ok: false, error, message });

/** UUID v7 gerado pela aplicação (ordenável por tempo). */
export const newId = () => v7();

/** Quem executa o caso de uso. Vem sempre da sessão autenticada, nunca do corpo da requisição. */
export type ServiceCtx = {
  organizationId: string;
  userId: string;
  userName: string;
  /** Fuso da empresa (IANA). */
  timeZone: string;
  orgName: string;
};

/** Código SQLSTATE do erro do Postgres (o Drizzle embrulha o erro do driver em `cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = typeof current === "object" && current !== null && "cause" in current ? (current as { cause: unknown }).cause : undefined;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_EXCLUSION_VIOLATION = "23P01";

/** Divide em lotes (inserts grandes ficam abaixo do limite de parâmetros do Postgres). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
