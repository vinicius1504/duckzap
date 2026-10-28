import "server-only";
import type { PlanSlug } from "@duckzap/contracts/session";
import {
  accountSchema,
  apiKeySchema,
  billingSchema,
  companySchema,
  createdApiKeySchema,
  createdWebhookSchema,
  integrationsSchema,
  planSchema,
  serviceSettingsSchema,
  twoFactorSetupSchema,
  webhookSchema,
  webhookTestResultSchema,
  type Account,
  type ApiKey,
  type Billing,
  type ChangePasswordInput,
  type Company,
  type CreateApiKeyInput,
  type CreatedApiKey,
  type CreatedWebhook,
  type CreateWebhookInput,
  type Integrations,
  type NotificationPrefs,
  type Plan,
  type ServiceSettings,
  type TwoFactorSetup,
  type UpdateCompanyInput,
  type UpdateProfileInput,
  type Webhook,
  type WebhookTestResult,
} from "@duckzap/contracts/settings";
import { z } from "zod";
import { callApi, callApiVoid, readApi } from "@/lib/api-call";
import { fail, ok, type Result } from "@/lib/mock";

// Ligado ao back (apps/api/src/modules/settings): /v1/settings/* e /v1/account/*.
// Segredos só voltam inteiros na criação (§5.2). Instagram segue o módulo Canais (ver getIntegrations).

// ---------- Planos ----------

export async function getPlanCatalog(): Promise<Plan[]> {
  return readApi("/v1/settings/plans", z.array(planSchema));
}

export async function getPlan(slug: PlanSlug): Promise<Plan> {
  const plan = (await getPlanCatalog()).find((p) => p.slug === slug);
  if (!plan) throw new Error(`Plano ${slug} não encontrado.`);
  return plan;
}

// ---------- Empresa ----------

export async function getCompany(): Promise<Company> {
  return readApi("/v1/settings/company", companySchema);
}

export async function updateCompany(input: UpdateCompanyInput): Promise<Result<Company>> {
  return callApi("/v1/settings/company", companySchema, { method: "PUT", body: input, errors: [], fallback: "invalid" });
}

// ---------- Atendimento ----------

export async function getServiceSettings(): Promise<ServiceSettings> {
  return readApi("/v1/settings/service", serviceSettingsSchema);
}

export async function updateServiceSettings(input: ServiceSettings): Promise<Result<ServiceSettings>> {
  return callApi("/v1/settings/service", serviceSettingsSchema, { method: "PUT", body: input, errors: [], fallback: "invalid" });
}

// ---------- Integrações ----------

export async function getIntegrations(): Promise<Integrations> {
  const [integrations, { getChannelsOverview }] = await Promise.all([
    readApi("/v1/settings/integrations", integrationsSchema),
    import("@/features/channels/api"),
  ]);
  // Instagram e WhatsApp oficial refletem os canais (a fonte é a mesma no back)
  const { channels } = await getChannelsOverview();
  const instagram = channels.find((c) => c.type === "instagram");
  const official = channels.find((c) => c.type === "whatsapp_official");
  return {
    ...integrations,
    instagram: {
      status: !instagram ? "disconnected" : instagram.status === "connected" ? "connected" : "awaiting_authorization",
      account: instagram?.address ?? instagram?.name ?? null,
    },
    whatsappOfficial: {
      ...integrations.whatsappOfficial,
      status: official?.status === "connected" ? "connected" : official ? "error" : integrations.whatsappOfficial.status,
    },
  };
}

/** Sem OAuth real nesta fase: o back só registra a conexão. */
export async function connectGoogleCalendar(): Promise<Result<null>> {
  return callApiVoid("/v1/settings/integrations/google-calendar/connect", { method: "POST", errors: [], fallback: "invalid" });
}

export async function disconnectGoogleCalendar(): Promise<Result<null>> {
  return callApiVoid("/v1/settings/integrations/google-calendar/disconnect", { method: "POST", errors: [], fallback: "invalid" });
}

/** Autoriza o Instagram ligado ao canal do Instagram (mesmo fluxo de Canais). */
export async function authorizeInstagramIntegration(): Promise<Result<null, "no_channel" | "not_found">> {
  const { getChannelsOverview, authorizeInstagram } = await import("@/features/channels/api");
  const { channels } = await getChannelsOverview();
  const instagram = channels.find((c) => c.type === "instagram");
  if (!instagram) return fail("no_channel", "Crie um canal do Instagram em Canais primeiro.");
  const result = await authorizeInstagram(instagram.id);
  return result.ok ? ok(null) : result;
}

export async function updateWhatsappOfficialToken(accessToken: string): Promise<Result<null, "invalid_credentials">> {
  return callApiVoid("/v1/settings/integrations/whatsapp-official/token", {
    method: "PUT",
    body: { accessToken },
    errors: ["invalid_credentials"],
    fallback: "invalid_credentials",
  });
}

// ---------- Chaves de API ----------

export async function listApiKeys(): Promise<ApiKey[]> {
  return readApi("/v1/settings/api-keys", z.array(apiKeySchema));
}

/** Cria a chave. O segredo completo só existe nesta resposta (o back guarda o hash). */
export async function createApiKey(input: CreateApiKeyInput): Promise<Result<CreatedApiKey>> {
  return callApi("/v1/settings/api-keys", createdApiKeySchema, { method: "POST", body: input, errors: [], fallback: "invalid" });
}

export async function revokeApiKey(id: string): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/settings/api-keys/${encodeURIComponent(id)}`, { method: "DELETE", errors: ["not_found"], fallback: "not_found" });
}

// ---------- Webhooks ----------

export async function listWebhooks(): Promise<Webhook[]> {
  return readApi("/v1/settings/webhooks", z.array(webhookSchema));
}

export async function createWebhook(input: CreateWebhookInput): Promise<Result<CreatedWebhook, "duplicate" | "unsafe_url">> {
  return callApi("/v1/settings/webhooks", createdWebhookSchema, {
    method: "POST",
    body: input,
    errors: ["duplicate", "unsafe_url"],
    fallback: "unsafe_url",
  });
}

/** Envia um evento `ping` assinado (HMAC-SHA256) para a URL. */
export async function testWebhook(id: string): Promise<Result<WebhookTestResult, "not_found">> {
  return callApi(`/v1/settings/webhooks/${encodeURIComponent(id)}/test`, webhookTestResultSchema, {
    method: "POST",
    errors: ["not_found"],
    fallback: "not_found",
  });
}

export async function setWebhookActive(id: string, active: boolean): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/settings/webhooks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { active },
    errors: ["not_found"],
    fallback: "not_found",
  });
}

export async function deleteWebhook(id: string): Promise<Result<null, "not_found">> {
  return callApiVoid(`/v1/settings/webhooks/${encodeURIComponent(id)}`, { method: "DELETE", errors: ["not_found"], fallback: "not_found" });
}

// ---------- Plano e cobrança ----------

export async function getBilling(): Promise<Billing> {
  return readApi("/v1/settings/billing", billingSchema);
}

/**
 * Pede a troca de plano. Upgrade devolve o link de pagamento; downgrade só se o uso couber no plano novo.
 * `[LINK]` = link de checkout ainda não definido.
 */
export async function requestPlanChange(slug: PlanSlug): Promise<Result<{ checkoutUrl: string }, "same_plan" | "over_limit">> {
  return callApi("/v1/settings/billing/plan-change", z.object({ checkoutUrl: z.string() }), {
    method: "POST",
    body: { plan: slug },
    errors: ["same_plan", "over_limit"],
    fallback: "over_limit",
  });
}

// ---------- Minha conta ----------
// O `userId` vem da sessão no servidor; o parâmetro fica para manter a assinatura da fase de mock.

export async function getAccount(_userId: string): Promise<Account> {
  return readApi("/v1/account", accountSchema);
}

export async function updateProfile(_userId: string, input: UpdateProfileInput): Promise<Result<null>> {
  return callApiVoid("/v1/account/profile", { method: "PATCH", body: input, errors: [], fallback: "invalid" });
}

export async function changePassword(
  _userId: string,
  input: ChangePasswordInput,
): Promise<Result<null, "wrong_password" | "same_password">> {
  return callApiVoid("/v1/account/password", {
    method: "POST",
    body: input,
    errors: ["wrong_password", "same_password"],
    fallback: "wrong_password",
    forwardCookies: true,
  });
}

/** O Better Auth exige a senha para começar a configurar o 2FA. */
export async function startTwoFactorSetup(_userId: string, password: string): Promise<Result<TwoFactorSetup>> {
  return callApi("/v1/account/two-factor/setup", twoFactorSetupSchema, {
    method: "POST",
    body: { password },
    errors: [],
    fallback: "invalid",
    forwardCookies: true,
  });
}

/** Confere o código do app, liga o 2FA e devolve os códigos de recuperação (mostrados uma vez). */
export async function confirmTwoFactor(
  _userId: string,
  code: string,
): Promise<Result<{ recoveryCodes: string[] }, "no_setup" | "invalid_code">> {
  return callApi("/v1/account/two-factor/confirm", z.object({ recoveryCodes: z.array(z.string()) }), {
    method: "POST",
    body: { code },
    errors: ["no_setup", "invalid_code"],
    fallback: "invalid_code",
    forwardCookies: true,
  });
}

export async function disableTwoFactor(_userId: string, password: string): Promise<Result<null, "required">> {
  return callApiVoid("/v1/account/two-factor/disable", {
    method: "POST",
    body: { password },
    errors: ["required"],
    fallback: "required",
    forwardCookies: true,
  });
}

export async function updateNotifications(_userId: string, prefs: NotificationPrefs): Promise<Result<null>> {
  return callApiVoid("/v1/account/notifications", { method: "PUT", body: prefs, errors: [], fallback: "invalid" });
}
