import "server-only";
import {
  type Agent,
  type AgentChannel,
  agentChannelSchema,
  type AgentConfig,
  type AgentGeneratorOutput,
  agentGeneratorOutputSchema,
  type AgentGeneratorParsedInput,
  agentPlanUsageSchema,
  agentSchema,
  type AgentStatus,
  type AgentVersion,
  agentVersionSchema,
  type AppointmentType,
  appointmentTypeSchema,
  type CopilotOverview,
  copilotOverviewSchema,
  type CreateAgentInput,
  type KnowledgeDocument,
  knowledgeDocumentSchema,
  type SimulatorMessage,
  type SimulatorReply,
  simulatorReplySchema,
} from "@duckzap/contracts/agents";
import { z } from "zod";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import { apiFetch } from "@/lib/api-server";
import { GENERATE_CLIENT_TIMEOUT_MS, failure, mapGenerateFailure, type GenerateFailure } from "@/lib/agent-generator";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/agents): /v1/agents/*, /v1/copilot.
// Limites de plano (Essencial = 1 agente, Instagram e Copiloto só no Escala), tipos "só a equipe marca" e o
// versionamento (toda alteração cria versão; voltar = mover o ponteiro) são aplicados no SERVIDOR.
// Upload de documentos: o back aceita metadados + texto extraído; o arquivo em si (e a leitura de PDF/DOCX)
// é a próxima etapa — por isso a ação atual, que só envia nome e tamanho, resulta em "falhou" com motivo.

const agentList = z.array(agentSchema);
const versionList = z.array(agentVersionSchema);

export async function listAgents(): Promise<Agent[]> {
  return readApi("/v1/agents", agentList);
}

export async function getAgent(id: string): Promise<Agent | null> {
  const result = await callApi(`/v1/agents/${encodeURIComponent(id)}`, agentSchema, { errors: ["not_found"] as const, fallback: "unavailable" as const });
  if (result.ok) return result.data;
  if (result.error === "not_found") return null;
  throw new Error(result.message);
}

export async function listAgentChannels(): Promise<AgentChannel[]> {
  return readApi("/v1/agents/channels", z.array(agentChannelSchema));
}

export async function listAppointmentTypes(): Promise<AppointmentType[]> {
  return readApi("/v1/agents/appointment-types", z.array(appointmentTypeSchema));
}

export async function listAgentVersions(agentId: string): Promise<AgentVersion[]> {
  return readApi(`/v1/agents/${encodeURIComponent(agentId)}/versions`, versionList);
}

export async function getCopilotOverview(): Promise<CopilotOverview> {
  return readApi("/v1/copilot", copilotOverviewSchema);
}

/** `author` é ignorado: o servidor registra quem fez a alteração a partir da sessão. */
export async function createAgent(input: CreateAgentInput, _author: string): Promise<Result<Agent>> {
  return callApi("/v1/agents", agentSchema, { method: "POST", body: input, errors: [] as readonly string[], fallback: "error" });
}

/** Toda alteração cria uma versão nova (§4.3 Versionamento). */
export async function updateAgentConfig(id: string, config: AgentConfig, _author: string): Promise<Result<Agent, "not_found">> {
  return callApi(`/v1/agents/${encodeURIComponent(id)}/config`, agentSchema, { method: "PUT", body: config, errors: ["not_found"] as const, fallback: "not_found" });
}

/** Voltar a uma versão = mover o ponteiro da versão ativa (o histórico nunca é apagado). */
export async function rollbackAgentVersion(id: string, versionId: string, _author: string): Promise<Result<Agent, "not_found">> {
  return callApi(`/v1/agents/${encodeURIComponent(id)}/rollback`, agentSchema, {
    method: "POST",
    body: { versionId },
    errors: ["not_found"] as const,
    fallback: "not_found",
  });
}

export async function setAgentStatus(id: string, status: AgentStatus): Promise<Result<Agent, "not_found" | "no_channel">> {
  return callApi(`/v1/agents/${encodeURIComponent(id)}/status`, agentSchema, {
    method: "POST",
    body: { status },
    errors: ["not_found", "no_channel"] as const,
    fallback: "not_found",
  });
}

export async function uploadAgentDocument(
  id: string,
  file: { name: string; sizeBytes: number; text?: string },
): Promise<Result<KnowledgeDocument, "not_found" | "invalid_file">> {
  return callApi(`/v1/agents/${encodeURIComponent(id)}/documents`, knowledgeDocumentSchema, {
    method: "POST",
    body: file,
    errors: ["not_found", "invalid_file"] as const,
    fallback: "invalid_file",
  });
}

export async function removeAgentDocument(id: string, documentId: string): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/agents/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    errors: ["not_found"] as const,
    fallback: "not_found",
  });
}

/**
 * Simulador: o servidor roda o MESMO pipeline do agente com as tools em dry-run (nunca envia nem grava).
 * Usa a configuração passada (pode ser o rascunho ainda não salvo).
 */
export async function simulateAgentReply(
  agentId: string,
  config: AgentConfig,
  history: SimulatorMessage[],
): Promise<Result<SimulatorReply, "not_found">> {
  return callApi(`/v1/agents/${encodeURIComponent(agentId)}/simulate`, simulatorReplySchema, {
    method: "POST",
    body: { config, history },
    errors: ["not_found"] as const,
    fallback: "not_found",
  });
}

export async function getAgentPlanUsage(): Promise<{ agents: number }> {
  return readApi("/v1/agents/plan-usage", agentPlanUsageSchema);
}

export async function setCopilotEnabled(enabled: boolean): Promise<Result<CopilotOverview>> {
  return callApi("/v1/copilot", copilotOverviewSchema, { method: "PUT", body: { enabled }, errors: [] as readonly string[], fallback: "error" });
}

export type GenerateAgentResult = { ok: true; data: AgentGeneratorOutput } | { ok: false; error: GenerateFailure };

/**
 * Gera o perfil do agente (descrição, instruções, conhecimento e exemplos) a partir dos dados da empresa. NÃO grava nada:
 * o dono revisa e salva pelo fluxo normal de agentes.
 *
 * Uma geração leva ~20–25 s e pode chegar a ~2 min (prazo total da API: 270 s). O `apiFetch` padrão desiste em 10 s,
 * então aqui o tempo é próprio (`GENERATE_CLIENT_TIMEOUT_MS`) e junto o `signal` de quem chamou: se o navegador
 * cancelar, a chamada à API é abortada e a API para de gastar IA.
 * Não usa o `callApi`: ele descarta o `fields` do 422 e troca a mensagem do 429. A interpretação do erro está em
 * `mapGenerateFailure`. Sessão e suspensão (401/403) voltam como `gate`, e a tela faz o mesmo redirecionamento do
 * `handleAccessGate` (um `redirect()` aqui viraria uma resposta HTML no meio de um fetch).
 */
export async function generateAgentProfile(input: AgentGeneratorParsedInput, signal?: AbortSignal): Promise<GenerateAgentResult> {
  const timeout = AbortSignal.timeout(GENERATE_CLIENT_TIMEOUT_MS - 5_000);
  let response: Response;
  try {
    response = await apiFetch("/v1/agents/generate", {
      method: "POST",
      body: JSON.stringify(input),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: failure("unavailable", { message: "Geração cancelada." }) };
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, error: failure(timedOut ? "timeout" : "unavailable") };
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    return { ok: false, error: mapGenerateFailure(response.status, body, response.headers.get("retry-after")) };
  }
  const parsed = agentGeneratorOutputSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { ok: false, error: failure("generation_failed") };
  return { ok: true, data: parsed.data };
}
