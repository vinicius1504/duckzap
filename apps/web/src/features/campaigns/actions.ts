"use server";

import { campaignDraftInputSchema, campaignMessageTypeSchema, generateVariationsInputSchema } from "@duckzap/contracts/campaigns";
import { isSendingPaused } from "@duckzap/contracts/session";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Session } from "@duckzap/contracts/session";
import { authorize } from "@/features/auth/permissions";
import * as api from "./api";

// Server Actions finas: sessão → validação → api.ts → revalidar. Regras ficam no servidor (api/worker).

type ActionResult<T = null> = { error: string } | { error?: undefined; data: T };

const SENDING_PAUSED = "Seu plano expirou. Os envios ficam pausados até a assinatura ser renovada.";
const PLAN_REQUIRED = "Campanhas fazem parte dos planos Pro e Empresarial.";

/** Permissão (campaign.manage; disparo/retomada também campaign.send) → plano → assinatura. */
async function guard({ sending = false } = {}): Promise<{ session: Session; error: null } | { session?: undefined; error: string }> {
  const auth = await authorize("campaign.manage");
  if ("error" in auth) return { error: auth.error };
  const { session } = auth;
  if (sending) {
    const sendAuth = await authorize("campaign.send");
    if ("error" in sendAuth) return { error: sendAuth.error };
  }
  if (!session.organization.features.includes("campaigns")) return { error: PLAN_REQUIRED };
  if (sending && isSendingPaused(session)) return { error: SENDING_PAUSED };
  return { session, error: null };
}

const idSchema = z.string().min(1);

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Confira os campos e tente de novo.";
}

function refresh(id?: string) {
  revalidatePath("/campanhas");
  if (id) revalidatePath(`/campanhas/${id}`);
}

export async function saveCampaignDraftAction(id: string | null, input: unknown): Promise<ActionResult<{ id: string }>> {
  const { error } = await guard();
  if (error) return { error };
  const parsed = campaignDraftInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = id ? await api.updateCampaignDraft(idSchema.parse(id), parsed.data) : await api.createCampaignDraft(parsed.data);
  if (!result.ok) return { error: result.message };
  refresh(result.data.id);
  return { data: { id: result.data.id } };
}

export async function generateVariationsAction(input: unknown) {
  const { error } = await guard();
  if (error) return { error };
  const parsed = generateVariationsInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.generateVariations(parsed.data);
  if (!result.ok) return { error: result.message };
  return { data: result.data };
}

export async function acceptCampaignTermsAction(): Promise<ActionResult> {
  const guarded = await guard({ sending: true });
  if (guarded.error !== null) return { error: guarded.error };
  const result = await api.acceptCampaignTerms(guarded.session.user.name);
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: null };
}

export async function launchCampaignAction(id: string): Promise<ActionResult<{ id: string }>> {
  const { error } = await guard({ sending: true });
  if (error) return { error };
  const result = await api.launchCampaign(idSchema.parse(id));
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: { id } };
}

const lifecycle = { pause: api.pauseCampaign, resume: api.resumeCampaign, cancel: api.cancelCampaign } as const;

export async function changeCampaignStatusAction(id: string, change: keyof typeof lifecycle): Promise<ActionResult> {
  const op = z.enum(["pause", "resume", "cancel"]).parse(change);
  // pausar e cancelar sempre podem; retomar é envio
  const { error } = await guard({ sending: op === "resume" });
  if (error) return { error };
  const result = await lifecycle[op](idSchema.parse(id));
  if (!result.ok) return { error: result.message };
  refresh(id);
  return { data: null };
}

export async function duplicateCampaignAction(id: string): Promise<ActionResult<{ id: string }>> {
  const { error } = await guard();
  if (error) return { error };
  const result = await api.duplicateCampaign(idSchema.parse(id));
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: { id: result.data.id } };
}

export async function deleteCampaignDraftAction(id: string): Promise<ActionResult> {
  const { error } = await guard();
  if (error) return { error };
  const result = await api.deleteCampaignDraft(idSchema.parse(id));
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: null };
}

const templateInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome para o modelo.").max(60),
  type: campaignMessageTypeSchema,
  body: z.string().trim().min(1, "O modelo precisa de uma mensagem.").max(1024),
  buttons: z.array(z.string().trim().min(1).max(20)).max(3),
});

export async function saveCampaignTemplateAction(input: unknown): Promise<ActionResult> {
  const { error } = await guard();
  if (error) return { error };
  const parsed = templateInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.saveCampaignTemplate(parsed.data);
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: null };
}

export async function deleteCampaignTemplateAction(id: string): Promise<ActionResult> {
  const { error } = await guard();
  if (error) return { error };
  const result = await api.deleteCampaignTemplate(idSchema.parse(id));
  if (!result.ok) return { error: result.message };
  refresh();
  return { data: null };
}
