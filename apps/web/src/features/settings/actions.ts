"use server";

import { planSlugSchema } from "@duckzap/contracts/session";
import {
  changePasswordInputSchema,
  createApiKeyInputSchema,
  createWebhookInputSchema,
  notificationPrefsSchema,
  serviceSettingsSchema,
  totpCodeSchema,
  updateCompanyInputSchema,
  updateProfileInputSchema,
  type CreatedApiKey,
  type CreatedWebhook,
  type TwoFactorSetup,
  type WebhookTestResult,
} from "@duckzap/contracts/settings";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import { requireSession } from "@/features/auth/session";
import type { Result } from "@/lib/mock";
import {
  authorizeInstagramIntegration,
  changePassword,
  confirmTwoFactor,
  connectGoogleCalendar,
  createApiKey,
  createWebhook,
  deleteWebhook,
  disableTwoFactor,
  disconnectGoogleCalendar,
  requestPlanChange,
  revokeApiKey,
  setWebhookActive,
  startTwoFactorSetup,
  testWebhook,
  updateCompany,
  updateNotifications,
  updateProfile,
  updateServiceSettings,
  updateWhatsappOfficialToken,
} from "./api";

// Server Actions finas: permissão → validação → api.ts → revalidar. Nenhuma regra de negócio aqui.

export type ActionResult<T> = { ok: true; data: T } | { ok?: false; error: string };

const idSchema = z.string().min(1).max(64);

function done<T>(result: Result<T>, paths: string[] = ["/ajustes"]): ActionResult<T> {
  if (!result.ok) return { ok: false, error: result.message };
  for (const path of paths) revalidatePath(path);
  return result;
}

/** Sem dado para devolver ao client (ex.: a empresa salva volta pela revalidação). */
function doneEmpty(result: Result<unknown>, paths?: string[]): ActionResult<null> {
  const r = done(result, paths);
  return r.ok ? { ok: true, data: null } : r;
}

function invalid(error: z.ZodError): ActionResult<never> {
  return { ok: false, error: error.issues[0]?.message ?? "Confira os campos." };
}

// ---------- Empresa e Atendimento (settings.manage) ----------

export async function updateCompanyAction(input: unknown): Promise<ActionResult<null>> {
  const auth = await authorize("settings.manage");
  if ("error" in auth) return auth;
  const parsed = updateCompanyInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return doneEmpty(await updateCompany(parsed.data));
}

export async function updateServiceSettingsAction(input: unknown): Promise<ActionResult<null>> {
  const auth = await authorize("settings.manage");
  if ("error" in auth) return auth;
  const parsed = serviceSettingsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return doneEmpty(await updateServiceSettings(parsed.data));
}

// ---------- Integrações (integration.manage) ----------

export async function connectGoogleCalendarAction(): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await connectGoogleCalendar());
}

export async function disconnectGoogleCalendarAction(): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await disconnectGoogleCalendar());
}

export async function authorizeInstagramAction(): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await authorizeInstagramIntegration(), ["/ajustes", "/canais"]);
}

export async function updateWhatsappTokenAction(accessToken: string): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  const parsed = z.string().trim().min(20, "Cole o token de acesso completo.").safeParse(accessToken);
  if (!parsed.success) return invalid(parsed.error);
  return done(await updateWhatsappOfficialToken(parsed.data));
}

export async function createApiKeyAction(input: unknown): Promise<ActionResult<CreatedApiKey>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  const parsed = createApiKeyInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await createApiKey(parsed.data));
}

export async function revokeApiKeyAction(id: string): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await revokeApiKey(idSchema.parse(id)));
}

export async function createWebhookAction(input: unknown): Promise<ActionResult<CreatedWebhook>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  const parsed = createWebhookInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await createWebhook(parsed.data));
}

export async function testWebhookAction(id: string): Promise<ActionResult<WebhookTestResult>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await testWebhook(idSchema.parse(id)));
}

export async function setWebhookActiveAction(id: string, active: boolean): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await setWebhookActive(idSchema.parse(id), z.boolean().parse(active)));
}

export async function deleteWebhookAction(id: string): Promise<ActionResult<null>> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  return done(await deleteWebhook(idSchema.parse(id)));
}

// ---------- Plano (billing.manage) ----------

export async function requestPlanChangeAction(slug: string): Promise<ActionResult<{ checkoutUrl: string }>> {
  const auth = await authorize("billing.manage");
  if ("error" in auth) return auth;
  const parsed = planSlugSchema.safeParse(slug);
  if (!parsed.success) return { ok: false, error: "Plano inválido." };
  return done(await requestPlanChange(parsed.data));
}

// ---------- Minha conta (a própria pessoa) ----------

export async function updateProfileAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  const parsed = updateProfileInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await updateProfile(session.user.id, parsed.data));
}

export async function changePasswordAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  const parsed = changePasswordInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await changePassword(session.user.id, parsed.data), []);
}

const passwordSchema = z.string().min(1, "Informe sua senha.").max(128);

/** O Better Auth pede a senha para iniciar e para desativar o 2FA. */
export async function startTwoFactorAction(password: string): Promise<ActionResult<TwoFactorSetup>> {
  const session = await requireSession();
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return invalid(parsed.error);
  return done(await startTwoFactorSetup(session.user.id, parsed.data), []);
}

export async function confirmTwoFactorAction(code: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const session = await requireSession();
  const parsed = totpCodeSchema.safeParse(code.replace(/\s/g, ""));
  if (!parsed.success) return invalid(parsed.error);
  return done(await confirmTwoFactor(session.user.id, parsed.data), ["/ajustes", "/equipe"]);
}

export async function disableTwoFactorAction(password: string): Promise<ActionResult<null>> {
  const session = await requireSession();
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) return invalid(parsed.error);
  return done(await disableTwoFactor(session.user.id, parsed.data), ["/ajustes", "/equipe"]);
}

export async function updateNotificationsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  const parsed = notificationPrefsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await updateNotifications(session.user.id, parsed.data));
}
