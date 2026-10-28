import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { formatZodError, validationBody } from "../lib/http-validation";

/** Código SQLSTATE do erro do Postgres, mesmo embrulhado pelo Drizzle (`cause`). */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const HTTP_MESSAGES: Record<number, { code: string; message: string }> = {
  400: { code: "bad_request", message: "A requisição está malformada." },
  401: { code: "unauthorized", message: "Entre para continuar." },
  403: { code: "forbidden", message: "Você não tem permissão para fazer isso." },
  404: { code: "not_found", message: "Não encontrado." },
  405: { code: "method_not_allowed", message: "Método não permitido." },
  413: { code: "too_large", message: "O envio é grande demais." },
  415: { code: "unsupported_media_type", message: "Formato de conteúdo não aceito." },
  429: { code: "rate_limited", message: "Muitas tentativas. Aguarde um pouco e tente de novo." },
};

export const onError: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    // mensagens do framework vêm em inglês: usa as nossas quando o status é conhecido
    const known = HTTP_MESSAGES[err.status];
    return c.json({ error: known ?? { code: "http_error", message: err.message } }, err.status);
  }
  if (err instanceof ZodError) return c.json(validationBody(formatZodError(err)), 422);
  // rede de segurança: id malformado (22P02) ou fora de faixa (22003) que escapou da validação é erro de entrada, não 500
  const code = pgCode(err);
  if (code === "22P02" || code === "22003" || code === "22007" || code === "22008") {
    return c.json({ error: { code: "validation_error", message: "Um dos valores enviados é inválido. Confira os campos." } }, 422);
  }
  // detalhes só no log do servidor, nunca na resposta
  console.error({ requestId: c.get("requestId"), err });
  return c.json(
    { error: { code: "internal_error", message: "Algo deu errado. Tente de novo." } },
    500,
  );
};

export const onNotFound: NotFoundHandler = (c) =>
  c.json({ error: { code: "not_found", message: "Rota não encontrada." } }, 404);
