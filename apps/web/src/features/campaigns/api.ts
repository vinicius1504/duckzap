import "server-only";
import {
  audienceSchema,
  campaignChannelSchema,
  campaignRecipientSchema,
  campaignSchema,
  campaignTemplateSchema,
  campaignTermsSchema,
  messageVariationSchema,
  type Audience,
  type Campaign,
  type CampaignChannel,
  type CampaignDraftInput,
  type CampaignRecipient,
  type CampaignTemplate,
  type CampaignTerms,
  type GenerateVariationsInput,
  type MessageVariation,
} from "@duckzap/contracts/campaigns";
import { z } from "zod";
import { get, readOrThrow, send, toResult, type CommonError } from "@/lib/api-result";
import { ok, type Result } from "@/lib/mock";

// Ligado ao back (apps/api · modules/campaigns). Cada função chama a rota correspondente, valida a resposta com o
// schema do contrato e mantém as assinaturas de antes. Toda regra de verdade roda no SERVIDOR (§5.7): público só com
// opt-in, limites de 50/dia e 15/h com aquecimento, intervalos aleatórios, janela de horário, validador das variações,
// disjuntor, termos antes do 1º disparo, bloqueio por plano. Rotas:
//   GET /v1/campaigns · /campaigns/{history,rejected,audiences,channels,templates,terms} · /campaigns/:id{,/recipients}
//   POST /v1/campaigns · /campaigns/{variations,templates,terms/accept} · /campaigns/:id/{launch,pause,resume,cancel,duplicate}
//   PUT /v1/campaigns/:id · DELETE /v1/campaigns/:id · /campaigns/templates/:id
// Quem dispara o envio é o motor no servidor (`runCampaignTick`, chamado pelo worker); a tela só acompanha.

const enc = encodeURIComponent;
const emptySchema = z.object({}).passthrough();

export async function listCampaigns(): Promise<Campaign[]> {
  return readOrThrow(await get("/v1/campaigns"), z.array(campaignSchema));
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const call = await get(`/v1/campaigns/${enc(id)}`);
  if (!call.ok && call.status === 404) return null;
  return readOrThrow(call, campaignSchema);
}

/** Campanhas encerradas (concluídas e canceladas), da mais recente para a mais antiga. */
export async function listCampaignHistory(): Promise<Campaign[]> {
  return readOrThrow(await get("/v1/campaigns/history"), z.array(campaignSchema));
}

export async function listCampaignRecipients(campaignId: string): Promise<CampaignRecipient[]> {
  const call = await get(`/v1/campaigns/${enc(campaignId)}/recipients`);
  if (!call.ok && call.status === 404) return [];
  return readOrThrow(call, z.array(campaignRecipientSchema));
}

/** Rejeitados: opt-out, sem WhatsApp e falha. Sem `campaignId`, de todas as campanhas. */
export async function listRejectedRecipients(campaignId?: string): Promise<CampaignRecipient[]> {
  const query = campaignId ? `?campaignId=${enc(campaignId)}` : "";
  return readOrThrow(await get(`/v1/campaigns/rejected${query}`), z.array(campaignRecipientSchema));
}

export async function listAudiences(): Promise<Audience[]> {
  return readOrThrow(await get("/v1/campaigns/audiences"), z.array(audienceSchema));
}

export async function listSendingChannels(): Promise<CampaignChannel[]> {
  return readOrThrow(await get("/v1/campaigns/channels"), z.array(campaignChannelSchema));
}

export async function listCampaignTemplates(): Promise<CampaignTemplate[]> {
  return readOrThrow(await get("/v1/campaigns/templates"), z.array(campaignTemplateSchema));
}

export async function getCampaignTerms(): Promise<CampaignTerms> {
  return readOrThrow(await get("/v1/campaigns/terms"), campaignTermsSchema);
}

/** Quem aceita é a pessoa da sessão: o servidor ignora qualquer nome enviado e guarda data, versão e autor. */
export async function acceptCampaignTerms(_userName: string): Promise<Result<CampaignTerms, CommonError>> {
  return toResult(await send("POST", "/v1/campaigns/terms/accept"), campaignTermsSchema, [] as const);
}

export async function createCampaignDraft(input: CampaignDraftInput): Promise<Result<Campaign, CommonError>> {
  return toResult(await send("POST", "/v1/campaigns", input), campaignSchema, [] as const);
}

export async function updateCampaignDraft(id: string, input: CampaignDraftInput): Promise<Result<Campaign, "not_found" | "not_draft" | CommonError>> {
  return toResult(await send("PUT", `/v1/campaigns/${enc(id)}`, input), campaignSchema, ["not_found", "not_draft"] as const);
}

export async function deleteCampaignDraft(id: string): Promise<Result<null, "not_found" | "not_draft" | CommonError>> {
  const result = toResult(await send("DELETE", `/v1/campaigns/${enc(id)}`), emptySchema, ["not_found", "not_draft"] as const);
  return result.ok ? ok(null) : result;
}

// ---------- variações por IA (servidor: nível rápido do LLM + validador de código) ----------

export async function generateVariations(input: GenerateVariationsInput): Promise<Result<MessageVariation[], "generation_failed" | CommonError>> {
  return toResult(await send("POST", "/v1/campaigns/variations", input), z.array(messageVariationSchema), ["generation_failed"] as const);
}

// ---------- ciclo de vida ----------

type LaunchError =
  | "not_found"
  | "not_draft"
  | "terms_required"
  | "no_audience"
  | "channel_unavailable"
  | "template_required"
  | "variations_required"
  | "invalid_message"
  | "invalid_window"
  | "invalid_schedule";

const launchErrors: readonly LaunchError[] = [
  "not_found",
  "not_draft",
  "terms_required",
  "no_audience",
  "channel_unavailable",
  "template_required",
  "variations_required",
  "invalid_message",
  "invalid_window",
  "invalid_schedule",
];

export async function launchCampaign(id: string): Promise<Result<Campaign, LaunchError | CommonError>> {
  return toResult(await send("POST", `/v1/campaigns/${enc(id)}/launch`), campaignSchema, launchErrors);
}

type LifecycleError = "not_found" | "invalid_state" | "channel_unavailable";
const lifecycleErrors: readonly LifecycleError[] = ["not_found", "invalid_state", "channel_unavailable"];

export async function pauseCampaign(id: string): Promise<Result<Campaign, LifecycleError | CommonError>> {
  return toResult(await send("POST", `/v1/campaigns/${enc(id)}/pause`), campaignSchema, lifecycleErrors);
}

/** Retomar é sempre manual, inclusive depois da parada automática (§5.7 item 5). */
export async function resumeCampaign(id: string): Promise<Result<Campaign, LifecycleError | CommonError>> {
  return toResult(await send("POST", `/v1/campaigns/${enc(id)}/resume`), campaignSchema, lifecycleErrors);
}

export async function cancelCampaign(id: string): Promise<Result<Campaign, LifecycleError | CommonError>> {
  return toResult(await send("POST", `/v1/campaigns/${enc(id)}/cancel`), campaignSchema, lifecycleErrors);
}

export async function duplicateCampaign(id: string): Promise<Result<Campaign, "not_found" | CommonError>> {
  return toResult(await send("POST", `/v1/campaigns/${enc(id)}/duplicate`), campaignSchema, ["not_found"] as const);
}

export async function saveCampaignTemplate(input: Pick<CampaignTemplate, "name" | "type" | "body" | "buttons">): Promise<Result<CampaignTemplate, CommonError>> {
  return toResult(await send("POST", "/v1/campaigns/templates", input), campaignTemplateSchema, [] as const);
}

export async function deleteCampaignTemplate(id: string): Promise<Result<null, "not_found" | "read_only" | CommonError>> {
  const result = toResult(await send("DELETE", `/v1/campaigns/templates/${enc(id)}`), emptySchema, ["not_found", "read_only"] as const);
  return result.ok ? ok(null) : result;
}
