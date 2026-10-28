import { agentGeneratorOutputSchema, type AgentGeneratorInput, type AgentGeneratorOutput } from "@duckzap/contracts/agents";
import { z } from "zod";
import { GENERATE_CLIENT_TIMEOUT_MS, failure, isGeneratorField, type GenerateFailure, type GeneratorFieldErrors } from "@/lib/agent-generator";

// Lado do navegador da geração: chama a rota `/agentes/gerar-perfil` (ver o comentário dela) e devolve sempre um resultado,
// nunca uma exceção. Cancelar = `controller.abort()`; o resultado de uma chamada cancelada é `{ cancelled: true }`.

export const GENERATE_ENDPOINT = "/agentes/gerar-perfil";

export type ClientGenerateResult =
  | { ok: true; data: AgentGeneratorOutput }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: GenerateFailure };

const failureSchema = z.object({
  code: z.enum(["invalid_input", "rate_limited", "budget_exceeded", "ai_unavailable", "generation_failed", "forbidden", "timeout", "unavailable"]),
  message: z.string(),
  retryable: z.boolean(),
  fields: z.record(z.string(), z.string()).optional(),
  retryAfterSeconds: z.number().optional(),
  gate: z.enum(["login", "suspended", "two_factor"]).optional(),
});
const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: agentGeneratorOutputSchema }),
  z.object({ ok: z.literal(false), error: failureSchema }),
]);

export async function requestGeneration(input: AgentGeneratorInput, signal: AbortSignal): Promise<ClientGenerateResult> {
  const timeout = AbortSignal.timeout(GENERATE_CLIENT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(GENERATE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.any([signal, timeout]),
      cache: "no-store",
    });
  } catch {
    if (signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: failure(timeout.aborted ? "timeout" : "unavailable") };
  }
  // sessão vencida: o proxy do Next responde com um redirecionamento para /entrar (HTML)
  if (response.redirected || !(response.headers.get("content-type") ?? "").includes("application/json")) {
    return { ok: false, error: failure("forbidden", { message: "Sua sessão expirou. Entre de novo para continuar.", retryable: false, gate: "login" }) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: failure(timeout.aborted ? "timeout" : "unavailable") };
  }
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: failure("unavailable") };
  if (parsed.data.ok) return { ok: true, data: parsed.data.data };
  const { fields: rawFields, ...rest } = parsed.data.error;
  const fields: GeneratorFieldErrors = {};
  for (const [key, message] of Object.entries(rawFields ?? {})) if (isGeneratorField(key)) fields[key] = message;
  return { ok: false, error: { ...rest, ...(Object.keys(fields).length ? { fields } : {}) } };
}

/** Para onde levar o usuário quando a sessão ou a conta barra a chamada (mesmos destinos do `handleAccessGate`). */
export function gateDestination(gate: NonNullable<GenerateFailure["gate"]>): string {
  if (gate === "login") return "/entrar";
  if (gate === "suspended") return "/inicio";
  return "/ajustes?aba=conta";
}
