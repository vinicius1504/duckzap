import { LlmError } from "../llm";

export function httpErrorCode(status: number) {
  if (status === 429) return { code: "rate_limited", retryable: true } as const;
  if (status === 529 || status >= 500) return { code: "overloaded", retryable: true } as const;
  if (status === 401 || status === 403) return { code: "auth", retryable: false } as const;
  if (status >= 400 && status < 500) return { code: "invalid_request", retryable: false } as const;
  return { code: "unknown", retryable: false } as const;
}

/** POST JSON com timeout + sinal externo; erros de rede/HTTP viram `LlmError` (usado por openai/gemini, sem SDK). */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    throw new LlmError("timeout", "Sem resposta do provedor de IA.", true, { cause: error });
  }
  if (!response.ok) {
    const mapped = httpErrorCode(response.status);
    throw new LlmError(mapped.code, `Provedor de IA respondeu ${response.status}.`, mapped.retryable);
  }
  return response.json();
}
