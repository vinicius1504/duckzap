"use server";

import { productAvailabilitySchema, productInputSchema, type Product, type ProductInput } from "@duckzap/contracts/catalog";
import { mediaUploadInitSchema, type MediaReady, type MediaUploadInitResult } from "@duckzap/contracts/media";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import { completeMediaUpload, initMediaUpload } from "@/features/conversations/api";
import { validateMediaFile } from "@/lib/media";
import * as api from "./api";

// Server Actions finas: permissão → validação → api.ts → revalidar. A API autoriza de verdade de novo.

export type ActionResult<T = null> = { ok: true; data: T } | { error: string };

const PATH = "/catalogo";
const id = z.string().min(1).max(64);

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Confira os campos.";
}

export async function saveProductAction(productId: string | null, input: ProductInput): Promise<ActionResult<Product>> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = productId ? await api.updateProduct(id.parse(productId), parsed.data) : await api.createProduct(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: result.data };
}

export async function setAvailabilityAction(productId: string, available: boolean): Promise<ActionResult> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const parsed = productAvailabilitySchema.safeParse({ available });
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.setProductAvailability(id.parse(productId), parsed.data.available);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function deleteProductAction(productId: string): Promise<ActionResult> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const result = await api.deleteProduct(id.parse(productId));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function attachImageAction(productId: string, mediaId: string): Promise<ActionResult<Product>> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const result = await api.attachProductImage(id.parse(productId), id.parse(mediaId));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: result.data };
}

export async function removeImageAction(productId: string, imageId: string): Promise<ActionResult<Product>> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const result = await api.removeProductImage(id.parse(productId), id.parse(imageId));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: result.data };
}

// Envio de foto: o mesmo fluxo de mídia das conversas (pedir URL → PUT direto no armazenamento → a API confere o arquivo),
// só que aqui a permissão é a do catálogo e só imagem passa.

export async function initPhotoUploadAction(input: unknown): Promise<{ error: string } | { upload: MediaUploadInitResult }> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const parsed = mediaUploadInitSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== "image") return { error: "Envie uma imagem JPG, PNG ou WebP." };
  const check = validateMediaFile("image", { name: parsed.data.fileName, type: parsed.data.mimeType, size: parsed.data.sizeBytes });
  if (!check.ok) return { error: check.message };
  const result = await initMediaUpload(parsed.data);
  return result.ok ? { upload: result.data } : { error: result.message };
}

export async function completePhotoUploadAction(mediaId: string): Promise<{ error: string } | { media: MediaReady }> {
  const auth = await authorize("catalog.manage");
  if ("error" in auth) return auth;
  const parsed = id.safeParse(mediaId);
  if (!parsed.success) return { error: "Arquivo inválido." };
  const result = await completeMediaUpload(parsed.data);
  return result.ok ? { media: result.data } : { error: result.message };
}
