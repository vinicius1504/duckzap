import "server-only";
import {
  channelSchema,
  channelsOverviewSchema,
  officialWebhookInfoSchema,
  qrSessionSchema,
  type Channel,
  type ChannelsOverview,
  type CreateChannelInput,
  type OfficialCredentialsInput,
  type OfficialWebhookInfo,
  type QrSession,
  type UpdateChannelSettingsInput,
} from "@duckzap/contracts/channels";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import type { Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/channels): /v1/channels/*. Limite do plano, tipos permitidos (Instagram só no Escala),
// nome duplicado, canal padrão e credenciais são aplicados no servidor; nenhuma credencial chega aqui.
//
// Em falha de rede, o código de erro cai no "fallback" da função (a mensagem do servidor/ de indisponibilidade é a que a tela mostra).
//
// Equipes e agentes do seletor de vínculo vêm da própria API de Canais (`GET /v1/channels`): o vínculo mora em
// `channels.team_id`/`channels.agent_id` (única fonte de verdade).

const idPath = (id: string) => encodeURIComponent(id);

export async function getChannelsOverview(): Promise<ChannelsOverview> {
  return readApi("/v1/channels", channelsOverviewSchema);
}

export async function createChannel(input: CreateChannelInput): Promise<Result<Channel, "plan_limit" | "type_not_allowed" | "duplicate_name">> {
  return callApi("/v1/channels", channelSchema, { method: "POST", body: input, errors: ["plan_limit", "type_not_allowed", "duplicate_name"], fallback: "plan_limit" });
}

/** Gera (ou renova) o QR do canal. O código expira em ~30 s. */
export async function startQrSession(channelId: string): Promise<Result<QrSession, "not_found" | "wrong_type">> {
  return callApi(`/v1/channels/${idPath(channelId)}/qr`, qrSessionSchema, { method: "POST", errors: ["not_found", "wrong_type"], fallback: "not_found" });
}

/** Consulta o QR (a tela chama a cada poucos segundos). */
export async function getQrSession(channelId: string): Promise<Result<QrSession, "not_found">> {
  return callApi(`/v1/channels/${idPath(channelId)}/qr`, qrSessionSchema, { errors: ["not_found"], fallback: "not_found" });
}

export async function getOfficialWebhookInfo(channelId: string): Promise<OfficialWebhookInfo> {
  return readApi(`/v1/channels/${idPath(channelId)}/official-webhook`, officialWebhookInfoSchema);
}

export async function connectOfficialChannel(
  channelId: string,
  credentials: OfficialCredentialsInput,
): Promise<Result<Channel, "not_found" | "invalid_credentials">> {
  return callApi(`/v1/channels/${idPath(channelId)}/official-credentials`, channelSchema, { method: "POST", body: credentials, errors: ["not_found", "invalid_credentials"], fallback: "not_found" });
}

/**
 * SIMULADO no back nesta fase: marca o canal como conectado (sem OAuth real da Meta).
 */
export async function authorizeInstagram(channelId: string): Promise<Result<Channel, "not_found">> {
  return callApi(`/v1/channels/${idPath(channelId)}/instagram/authorize`, channelSchema, { method: "POST", errors: ["not_found"], fallback: "not_found" });
}

export async function disconnectChannel(channelId: string): Promise<Result<Channel, "not_found">> {
  return callApi(`/v1/channels/${idPath(channelId)}/disconnect`, channelSchema, { method: "POST", errors: ["not_found"], fallback: "not_found" });
}

export async function setDefaultChannel(channelId: string): Promise<Result<null, "not_found" | "not_whatsapp">> {
  return callApiVoid(`/v1/channels/${idPath(channelId)}/default`, { method: "POST", errors: ["not_found", "not_whatsapp"], fallback: "not_found" });
}

export async function updateChannelSettings(
  channelId: string,
  input: UpdateChannelSettingsInput,
): Promise<Result<Channel, "not_found" | "invalid_link">> {
  return callApi(`/v1/channels/${idPath(channelId)}`, channelSchema, { method: "PATCH", body: input, errors: ["not_found", "invalid_link"], fallback: "not_found" });
}

export async function deleteChannel(channelId: string): Promise<Result<null, "not_found" | "is_default">> {
  return callApiVoid(`/v1/channels/${idPath(channelId)}`, { method: "DELETE", errors: ["not_found", "is_default"], fallback: "not_found" });
}

/** Usado por Equipe: canais vinculados a uma equipe (a fonte é `channel.teamId`). */
export async function assignTeamChannels(teamId: string, channelIds: string[]): Promise<Result<null>> {
  return callApiVoid("/v1/channels/assign-team", { method: "POST", body: { teamId, channelIds }, errors: [], fallback: "unavailable" });
}
