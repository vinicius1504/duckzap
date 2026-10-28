import "server-only";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { apiFetch, forwardSetCookies } from "./api-server";
import { handleAccessGate } from "./access-gate";
import { fail, ok, type Result } from "./mock";

type ErrorBody = { error?: { code?: unknown; message?: unknown } };

type CallOptions<E extends string> = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Códigos de erro da API que a tela conhece; qualquer outro vira `fallback` (a mensagem do servidor é mantida). */
  errors: readonly E[];
  fallback: E;
  /** Repassa os Set-Cookie da API (troca de senha e 2FA renovam a sessão). */
  forwardCookies?: boolean;
};

const unavailable = "Não conseguimos falar com o servidor. Tente de novo em instantes.";

async function send<E extends string>(path: string, options: CallOptions<E>): Promise<{ response: Response } | { error: Result<never, E> }> {
  let response: Response;
  try {
    response = await apiFetch(path, {
      method: options.method ?? "GET",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    return { error: fail(options.fallback, unavailable) };
  }
  if (response.status === 401) redirect("/entrar");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    const code = typeof body?.error?.code === "string" ? body.error.code : "";
    if (response.status === 403) await handleAccessGate(code);
    const message =
      response.status === 429
        ? "Muitas tentativas. Aguarde um minuto e tente de novo."
        : typeof body?.error?.message === "string"
          ? body.error.message
          : "Algo deu errado. Tente de novo.";
    const known = options.errors.find((e) => e === code);
    return { error: fail(known ?? options.fallback, message) };
  }
  if (options.forwardCookies) await forwardSetCookies(response);
  return { response };
}

/** Chama a API e valida a resposta com o schema do contrato. */
export async function callApi<S extends z.ZodType, E extends string>(
  path: string,
  schema: S,
  options: CallOptions<E>,
): Promise<Result<z.output<S>, E>> {
  const sent = await send(path, options);
  if ("error" in sent) return sent.error;
  const parsed = schema.safeParse(await sent.response.json().catch(() => null));
  if (!parsed.success) return fail(options.fallback, "A resposta do servidor veio em um formato inesperado.");
  return ok(parsed.data);
}

/** Chamada cujo corpo de resposta não interessa (`{ ok: true }`). */
export async function callApiVoid<E extends string>(path: string, options: CallOptions<E>): Promise<Result<null, E>> {
  const sent = await send(path, options);
  if ("error" in sent) return sent.error;
  await sent.response.body?.cancel();
  return ok(null);
}

/** Leitura que não devolve `Result`: erro vira exceção (a tela cai no `error.tsx`). */
export async function readApi<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
  const result = await callApi(path, schema, { errors: [] as readonly string[], fallback: "unavailable" });
  if (!result.ok) throw new Error(result.message);
  return result.data;
}
