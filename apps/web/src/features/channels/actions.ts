"use server";

import {
  createChannelInputSchema,
  officialCredentialsInputSchema,
  updateChannelSettingsInputSchema,
  type Channel,
  type OfficialWebhookInfo,
  type QrSession,
} from "@duckzap/contracts/channels";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import type { Result } from "@/lib/mock";
import {
  authorizeInstagram,
  connectOfficialChannel,
  createChannel,
  deleteChannel,
  disconnectChannel,
  getOfficialWebhookInfo,
  getQrSession,
  setDefaultChannel,
  startQrSession,
  updateChannelSettings,
} from "./api";

// Server Actions finas: permissão → validação → api.ts → revalidar. Nenhuma regra de negócio aqui.

export type ActionResult<T> = { ok: true; data: T } | { ok?: false; error: string };

const idSchema = z.string().min(1).max(64);

function done<T>(result: Result<T>, revalidate = true): ActionResult<T> {
  if (!result.ok) return { ok: false, error: result.message };
  if (revalidate) {
    revalidatePath("/canais");
    revalidatePath("/", "layout"); // aviso de canal desconectado no topo e no Início
  }
  return result;
}

function invalid(error: z.ZodError): ActionResult<never> {
  return { ok: false, error: error.issues[0]?.message ?? "Confira os campos." };
}

export async function createChannelAction(input: { type: string; name: string }): Promise<ActionResult<Channel>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  const parsed = createChannelInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await createChannel(parsed.data));
}

export async function startQrAction(channelId: string): Promise<ActionResult<QrSession>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  return done(await startQrSession(idSchema.parse(channelId)), false);
}

/** Consulta periódica do QR. Revalida só quando conectou. */
export async function getQrStatusAction(channelId: string): Promise<ActionResult<QrSession>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  const result = await getQrSession(idSchema.parse(channelId));
  return done(result, result.ok && result.data.status === "connected");
}

export async function getOfficialWebhookInfoAction(channelId: string): Promise<ActionResult<OfficialWebhookInfo>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  return { ok: true, data: await getOfficialWebhookInfo(idSchema.parse(channelId)) };
}

export async function connectOfficialAction(
  channelId: string,
  input: { phoneNumberId: string; businessAccountId: string; accessToken: string },
): Promise<ActionResult<Channel>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  const parsed = officialCredentialsInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await connectOfficialChannel(idSchema.parse(channelId), parsed.data));
}

export async function authorizeInstagramAction(channelId: string): Promise<ActionResult<Channel>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  return done(await authorizeInstagram(idSchema.parse(channelId)));
}

export async function disconnectChannelAction(channelId: string): Promise<ActionResult<Channel>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  return done(await disconnectChannel(idSchema.parse(channelId)));
}

export async function setDefaultChannelAction(channelId: string): Promise<ActionResult<null>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  return done(await setDefaultChannel(idSchema.parse(channelId)));
}

export async function updateChannelSettingsAction(channelId: string, input: unknown): Promise<ActionResult<Channel>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  const parsed = updateChannelSettingsInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  return done(await updateChannelSettings(idSchema.parse(channelId), parsed.data));
}

export async function deleteChannelAction(channelId: string): Promise<ActionResult<null>> {
  const auth = await authorize("channel.manage");
  if ("error" in auth) return auth;
  return done(await deleteChannel(idSchema.parse(channelId)));
}
