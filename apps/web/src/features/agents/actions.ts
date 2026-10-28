"use server";

import {
  DOCUMENT_EXTENSIONS,
  INSTAGRAM_JOBS,
  MAX_DOCUMENT_BYTES,
  agentConfigSchema,
  agentStatusSchema,
  createAgentInputSchema,
  simulatorMessageSchema,
  type SimulatorReply,
} from "@duckzap/contracts/agents";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import * as api from "./api";

// Server Actions finas: permissão → validação → api.ts → revalidar.

type ActionResult<T = null> = { error: string } | { error?: undefined; data: T };

const idSchema = z.string().min(1).max(64);
const INSTAGRAM_PLAN = "Instagram faz parte dos planos Pro e Empresarial.";

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Confira os campos e tente de novo.";
}

function refresh(id?: string) {
  revalidatePath("/agentes");
  if (id) revalidatePath(`/agentes/${id}`);
}

export async function createAgentAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const parsed = createAgentInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const { features, maxAgents } = auth.session.organization;
  if (!features.includes("instagram") && INSTAGRAM_JOBS.includes(parsed.data.job)) return { error: INSTAGRAM_PLAN };
  if (maxAgents !== null && (await api.getAgentPlanUsage()).agents >= maxAgents) {
    return { error: `O seu plano permite ${maxAgents} ${maxAgents === 1 ? "agente" : "agentes"}. Mude de plano para ter mais.` };
  }
  const result = await api.createAgent(parsed.data, auth.session.user.name);
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: { id: result.data.id } };
}

export async function saveAgentConfigAction(id: string, config: unknown): Promise<ActionResult<{ version: number }>> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const parsed = agentConfigSchema.safeParse(config);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.updateAgentConfig(idSchema.parse(id), parsed.data, auth.session.user.name);
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: { version: result.data.currentVersion } };
}

export async function setAgentStatusAction(id: string, status: unknown): Promise<ActionResult> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const parsed = agentStatusSchema.safeParse(status);
  if (!parsed.success) return { error: "Status inválido." };
  if (parsed.data === "active") {
    const agent = await api.getAgent(idSchema.parse(id));
    if (agent && INSTAGRAM_JOBS.includes(agent.job) && !auth.session.organization.features.includes("instagram")) return { error: INSTAGRAM_PLAN };
  }
  const result = await api.setAgentStatus(idSchema.parse(id), parsed.data);
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: null };
}

export async function rollbackAgentVersionAction(id: string, versionId: string): Promise<ActionResult> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const result = await api.rollbackAgentVersion(idSchema.parse(id), idSchema.parse(versionId), auth.session.user.name);
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: null };
}

const fileMetaSchema = z.object({ name: z.string().trim().min(1).max(120), sizeBytes: z.number().int().min(0) });

/**
 * MOCK: recebe só nome e tamanho (Server Actions têm limite de 1 MB de corpo).
 * Com o back, o navegador envia o arquivo direto ao storage (URL assinada) e esta ação só registra.
 */
export async function uploadAgentDocumentAction(id: string, file: unknown): Promise<ActionResult> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const parsed = fileMetaSchema.safeParse(file);
  if (!parsed.success) return { error: "Escolha um arquivo." };
  const ext = parsed.data.name.split(".").pop()?.toLowerCase() ?? "";
  if (!DOCUMENT_EXTENSIONS.some((e) => e === ext)) return { error: "Envie PDF, DOCX ou TXT." };
  if (parsed.data.sizeBytes > MAX_DOCUMENT_BYTES) return { error: "O arquivo passa de 10 MB." };
  const result = await api.uploadAgentDocument(idSchema.parse(id), parsed.data);
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: null };
}

export async function removeAgentDocumentAction(id: string, documentId: string): Promise<ActionResult> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const result = await api.removeAgentDocument(idSchema.parse(id), idSchema.parse(documentId));
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: null };
}

export async function simulateAgentAction(id: string, config: unknown, history: unknown): Promise<ActionResult<SimulatorReply>> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  const parsedConfig = agentConfigSchema.safeParse(config);
  if (!parsedConfig.success) return { error: firstIssue(parsedConfig.error) };
  const parsedHistory = z.array(simulatorMessageSchema).max(40).safeParse(history);
  if (!parsedHistory.success) return { error: "Mensagem de teste inválida." };
  const result = await api.simulateAgentReply(idSchema.parse(id), parsedConfig.data, parsedHistory.data);
  if (!result.ok) return { error: result.message };
  return { data: result.data };
}

export async function setCopilotEnabledAction(enabled: boolean): Promise<ActionResult> {
  const auth = await authorize("agent.manage");
  if ("error" in auth) return auth;
  if (!auth.session.organization.features.includes("copilot")) return { error: "O Copiloto faz parte do plano Empresarial." };
  const result = await api.setCopilotEnabled(z.boolean().parse(enabled));
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: null };
}
