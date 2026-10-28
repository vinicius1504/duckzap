import "server-only";
import type { z, ZodType } from "zod";
import { apiFetch } from "@/lib/api-server";
import { handleAccessGate } from "@/lib/access-gate";
import { fail, ok, type Result } from "@/lib/mock";

/**
 * Cola entre os `features/<módulo>/api.ts` e a API: chama com `apiFetch` (repassa a sessão), converte o formato
 * de erro `{ error: { code, message } }` em `Result` e valida o corpo com o schema Zod do contrato.
 */

/** Erros que qualquer chamada pode devolver, além dos específicos de cada função. */
export type CommonError = "unavailable" | "forbidden" | "validation_error";

export type ApiCall =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; code: string; message: string; body: unknown };

export async function callApi(path: string, init: RequestInit = {}): Promise<ApiCall> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    return { ok: false, status: 0, code: "unavailable", message: "Não conseguimos falar com o servidor. Tente de novo em instantes.", body: null };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, status: response.status, json };
  const error = typeof json === "object" && json !== null && "error" in json ? (json as { error: unknown }).error : null;
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unavailable";
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : "Algo deu errado. Tente de novo.";
  if (response.status === 403) await handleAccessGate(code);
  return { ok: false, status: response.status, code, message, body: json };
}

export const get = (path: string) => callApi(path);
export const send = (method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) =>
  callApi(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function isOneOf<E extends string>(list: readonly E[], value: string): value is E {
  return (list as readonly string[]).includes(value);
}

/** Sucesso → dado validado; erro conhecido → `fail(código)`; o resto vira `forbidden` / `validation_error` / `unavailable`. */
export function toResult<S extends ZodType, E extends string>(
  call: ApiCall,
  schema: S,
  known: readonly E[],
): Result<z.output<S>, E | CommonError> {
  if (call.ok) return ok(schema.parse(call.json));
  if (isOneOf(known, call.code)) return fail(call.code, call.message);
  if (call.status === 403) return fail("forbidden", call.message);
  if (call.code === "validation_error") return fail("validation_error", call.message);
  return fail("unavailable", call.message);
}

/** Leituras sem `Result`: erro vira exceção (a tela cai no error boundary), como acontece com qualquer falha de dados. */
export function readOrThrow<S extends ZodType>(call: ApiCall, schema: S): z.output<S> {
  if (!call.ok) throw new Error(`API ${call.status} ${call.code}: ${call.message}`);
  return schema.parse(call.json);
}
