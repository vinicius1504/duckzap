import "server-only";
import {
  productListSchema,
  productSchema,
  whatsappCatalogSchema,
  whatsappImportResultSchema,
  type Product,
  type ProductInput,
  type ProductList,
  type WhatsappCatalog,
  type WhatsappImportInput,
  type WhatsappImportResult,
} from "@duckzap/contracts/catalog";
import { z } from "zod";
import { get, readOrThrow, send, toResult, type CommonError } from "@/lib/api-result";
import { type Result } from "@/lib/mock";

// Ligado ao back (apps/api · modules/catalog). Rotas: GET /v1/catalog/products · POST /catalog/products ·
// PATCH /catalog/products/:id · POST /catalog/products/:id/availability · DELETE /catalog/products/:id ·
// POST /catalog/products/:id/images · DELETE /catalog/products/:id/images/:imageId.
// As URLs das fotos são assinadas e curtas: a lista é lida a cada visita (nada de cache longo).

const enc = encodeURIComponent;
const deletedSchema = z.object({ ok: z.literal(true) });

export type SaveProductError = "name_taken" | "catalog_full" | "not_found" | CommonError;
export type WhatsappCatalogError = CommonError | "rate_limited";
export type WhatsappImportError =
  | "channel_not_found"
  | "channel_disconnected"
  | "not_business"
  | "provider_unavailable"
  | "rate_limited"
  | CommonError;
export type ImageError = "too_many_images" | "not_found" | "invalid_media" | CommonError;

export async function listProducts(): Promise<ProductList> {
  return readOrThrow(await get("/v1/catalog/products"), productListSchema);
}

export async function createProduct(input: ProductInput): Promise<Result<Product, SaveProductError>> {
  return toResult(await send("POST", "/v1/catalog/products", input), productSchema, ["name_taken", "catalog_full"] as const);
}

export async function updateProduct(id: string, input: ProductInput): Promise<Result<Product, SaveProductError>> {
  return toResult(await send("PATCH", `/v1/catalog/products/${enc(id)}`, input), productSchema, ["name_taken", "not_found"] as const);
}

export async function setProductAvailability(id: string, available: boolean): Promise<Result<Product, "not_found" | CommonError>> {
  return toResult(await send("POST", `/v1/catalog/products/${enc(id)}/availability`, { available }), productSchema, ["not_found"] as const);
}

export async function deleteProduct(id: string): Promise<Result<{ ok: true }, "not_found" | CommonError>> {
  return toResult(await send("DELETE", `/v1/catalog/products/${enc(id)}`), deletedSchema, ["not_found"] as const);
}

/** Liga uma foto já enviada e conferida (fluxo de mídia) ao produto. */
export async function attachProductImage(id: string, mediaId: string): Promise<Result<Product, ImageError>> {
  return toResult(await send("POST", `/v1/catalog/products/${enc(id)}/images`, { mediaId }), productSchema, ["too_many_images", "not_found", "invalid_media"] as const);
}

export async function removeProductImage(id: string, imageId: string): Promise<Result<Product, "not_found" | CommonError>> {
  return toResult(await send("DELETE", `/v1/catalog/products/${enc(id)}/images/${enc(imageId)}`), productSchema, ["not_found"] as const);
}

/** Catálogo do WhatsApp Business do canal (só lê; `channelId` vazio = o primeiro WhatsApp por QR Code). Limite de 10 chamadas por minuto. */
export async function getWhatsappCatalog(channelId?: string): Promise<Result<WhatsappCatalog, WhatsappCatalogError>> {
  const query = channelId ? `?channelId=${enc(channelId)}` : "";
  return toResult(await get(`/v1/catalog/whatsapp${query}`), whatsappCatalogSchema, ["rate_limited"] as const);
}

/** Copia produtos do catálogo do WhatsApp para o do sistema (os marcados ou todos). */
export async function importWhatsappProducts(input: WhatsappImportInput): Promise<Result<WhatsappImportResult, WhatsappImportError>> {
  return toResult(await send("POST", "/v1/catalog/whatsapp/import", input), whatsappImportResultSchema, [
    "channel_not_found",
    "channel_disconnected",
    "not_business",
    "provider_unavailable",
    "rate_limited",
  ] as const);
}
