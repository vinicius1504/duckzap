import {
  CATALOG_FULL,
  CATALOG_LIMITS,
  PRODUCT_NAME_TAKEN,
  type WhatsappCatalog,
  type WhatsappCatalogChannel,
  type WhatsappCatalogProduct,
  type WhatsappImportInput,
  type WhatsappImportResult,
} from "@duckzap/contracts/catalog";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { ProviderError, type ChannelRef, type MessagingProvider, type ProviderCatalog, type ProviderCatalogProduct } from "../../lib/messaging";
import { readCredentials } from "../channels/repo";
import { fail, newId, ok, type Result } from "../contacts/result";
import { MAX_INBOUND_BYTES, SIGNATURE_BYTES, hasSignature, resolveInboundType, storageKeyFor } from "../media/logic";
import { getMediaRuntime, type MediaRuntime } from "../media/runtime";
import { storeThumbnail } from "../media/service";
import type { CatalogCtx } from "./service";

const { products, productImages, mediaFiles, channels } = schema;

// Catálogo do WhatsApp Business: leitura (a Evolution só lê) + importação para o catálogo do sistema. O produto importado é uma
// CÓPIA (`source = 'whatsapp'`): nome, descrição e valor seguem o WhatsApp a cada importação; as fotos são baixadas na hora
// (os links do WhatsApp expiram) e guardadas como as demais fotos de produto.

/** Roda um trecho dentro do tenant. A chamada ao provedor e o download das fotos ficam FORA da transação: são lentos. */
export type RunInTenant = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

export type WhatsappCatalogDeps = {
  providers: { get(kind: string): MessagingProvider | undefined };
  log: { warn(message: string, meta?: Record<string, unknown>): void };
};

/** Baixa uma foto do catálogo do WhatsApp. null = não deu (host não permitido, grande demais, falha de rede). Nunca lança. */
export type ImageFetcher = (url: string) => Promise<{ bytes: Buffer; contentType: string | undefined } | null>;

type ChannelRow = typeof channels.$inferSelect;

const IMAGE_TIMEOUT_MS = 10_000;
/** Foto de produto no catálogo do WhatsApp é pequena; acima disso não vale guardar. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Só os servidores de mídia do próprio WhatsApp/Meta (o link vem do provedor; nunca buscamos um endereço qualquer). */
const ALLOWED_IMAGE_HOSTS = [".whatsapp.net", ".whatsapp.com", ".fbcdn.net", ".cdninstagram.com"] as const;

export function isAllowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some((suffix) => host.endsWith(suffix));
}

/** Fetcher padrão: só hosts do WhatsApp, sem seguir redirecionamento, com prazo e teto de tamanho (lido aos poucos). */
export function createImageFetcher(fetchImpl: typeof fetch = fetch): ImageFetcher {
  return async (url) => {
    if (!isAllowedImageUrl(url)) return null;
    try {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
      if (!response.ok || !response.body) return null;
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        await response.body.cancel().catch(() => {});
        return null;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += part.byteLength;
        if (total > MAX_IMAGE_BYTES) return null;
        chunks.push(Buffer.from(part));
      }
      return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? undefined };
    } catch {
      return null;
    }
  };
}

// ── canal e leitura ─────────────────────────────────────────────────────────

/** WhatsApps por QR Code da empresa: conectados primeiro, depois pelo mais antigo. */
async function listQrChannels(tx: Transaction, organizationId: string): Promise<ChannelRow[]> {
  const rows = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, organizationId), eq(channels.type, "whatsapp_qr")))
    .orderBy(asc(channels.createdAt), asc(channels.id));
  return [...rows.filter((r) => r.status === "connected"), ...rows.filter((r) => r.status !== "connected")];
}

const toChannelOption = (row: ChannelRow): WhatsappCatalogChannel => ({ id: row.id, name: row.name, address: row.address });

type ProviderRead =
  | { state: "ok"; catalog: ProviderCatalog }
  | { state: "channel_disconnected" }
  | { state: "not_business" }
  | { state: "unavailable" };

/** Lê o catálogo no provedor. Nunca lança: falha vira um estado que a tela explica. */
async function readProviderCatalog(row: ChannelRow, deps: WhatsappCatalogDeps): Promise<ProviderRead> {
  if (row.status !== "connected") return { state: "channel_disconnected" };
  const provider = deps.providers.get(row.provider);
  if (!provider?.listCatalog) return { state: "unavailable" };
  try {
    const ref: ChannelRef = { id: row.id, organizationId: row.organizationId, credentials: readCredentials(row), ...(row.address ? { address: row.address } : {}) };
    const catalog = await provider.listCatalog(ref);
    return catalog.isBusiness ? { state: "ok", catalog } : { state: "not_business" };
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "unknown";
    deps.log.warn("catalog.whatsapp.provider_error", { code });
    return { state: code === "invalid_credentials" ? "channel_disconnected" : "unavailable" };
  }
}

/** O canal pedido (precisa ser WhatsApp por QR Code da empresa) ou, sem pedido, o primeiro da lista. */
function chooseChannel(rows: ChannelRow[], requestedId: string | undefined): ChannelRow | null | undefined {
  if (requestedId) return rows.find((r) => r.id === requestedId);
  return rows[0] ?? null;
}

/** Produtos do catálogo do WhatsApp, marcando os que já foram importados. */
export async function loadWhatsappCatalog(
  run: RunInTenant,
  ctx: CatalogCtx,
  input: { channelId?: string | undefined },
  deps: WhatsappCatalogDeps,
): Promise<Result<WhatsappCatalog, "channel_not_found">> {
  const rows = await run((tx) => listQrChannels(tx, ctx.organizationId));
  const options = rows.map(toChannelOption);
  const chosen = chooseChannel(rows, input.channelId);
  if (chosen === undefined) return fail("channel_not_found", "WhatsApp não encontrado.");
  if (chosen === null) return ok({ state: "no_channel", channels: options, channelId: null, products: [] });

  const read = await readProviderCatalog(chosen, deps);
  if (read.state !== "ok") return ok({ state: read.state, channels: options, channelId: chosen.id, products: [] });

  const imported = await run(async (tx) => {
    const found = await tx
      .select({ id: products.id, externalId: products.externalId })
      .from(products)
      .where(and(eq(products.organizationId, ctx.organizationId), eq(products.channelId, chosen.id), eq(products.source, "whatsapp")));
    return new Map(found.flatMap((p) => (p.externalId ? [[p.externalId, p.id] as const] : [])));
  });
  const list: WhatsappCatalogProduct[] = read.catalog.products.map((p) => ({
    externalId: p.externalId,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    available: p.available,
    imageUrl: p.imageUrls[0] ?? null,
    imageCount: p.imageUrls.length,
    productId: imported.get(p.externalId) ?? null,
  }));
  return ok({ state: "ok", channels: options, channelId: chosen.id, products: list });
}

// ── importação ──────────────────────────────────────────────────────────────

type DownloadedPhoto = { id: string; storageKey: string; thumbKey: string | null; fileName: string; mimeType: string; sizeBytes: number };

/** Baixa, confere (tipo real pelos primeiros bytes) e guarda as fotos no armazenamento. Falha de uma foto não derruba as outras. */
async function downloadPhotos(urls: readonly string[], organizationId: string, rt: MediaRuntime, fetchImage: ImageFetcher): Promise<DownloadedPhoto[]> {
  if (!rt.storage) return [];
  const out: DownloadedPhoto[] = [];
  for (const url of urls.slice(0, CATALOG_LIMITS.maxImages)) {
    const got = await fetchImage(url);
    if (!got) continue;
    const resolved = resolveInboundType("image", got.contentType, undefined);
    const bytes = got.bytes;
    if (!resolved || bytes.length === 0 || bytes.length > MAX_INBOUND_BYTES || !hasSignature(resolved.type.signature, bytes.subarray(0, SIGNATURE_BYTES))) continue;
    const storageKey = storageKeyFor(organizationId, rt.now());
    try {
      await rt.storage.put(storageKey, bytes, { contentType: resolved.type.mime });
    } catch {
      rt.log.warn("catalog.whatsapp.store_failed", { organizationId });
      continue;
    }
    const thumbKey = await storeThumbnail(rt, storageKey, bytes);
    out.push({ id: newId(), storageKey, thumbKey, fileName: resolved.fileName, mimeType: resolved.type.mime, sizeBytes: bytes.length });
  }
  return out;
}

const keysOf = (photos: readonly DownloadedPhoto[]) => photos.flatMap((p) => (p.thumbKey ? [p.storageKey, p.thumbKey] : [p.storageKey]));

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

type OneOutcome = { kind: "created" | "updated" } | { kind: "skipped"; reason: string };

/** Cria ou atualiza UM produto (e liga as fotos, se for novo ou ainda sem foto). Roda numa transação própria. */
async function upsertOne(
  tx: Transaction,
  ctx: CatalogCtx,
  channelId: string,
  item: ProviderCatalogProduct,
  photos: readonly DownloadedPhoto[],
): Promise<OneOutcome> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`catalog:${ctx.organizationId}`}))`);
  const name = clip(item.name, CATALOG_LIMITS.nameMax);
  const description = clip(item.description, CATALOG_LIMITS.descriptionMax);

  const [existing] = await tx
    .select()
    .from(products)
    .where(and(eq(products.organizationId, ctx.organizationId), eq(products.channelId, channelId), eq(products.externalId, item.externalId)))
    .limit(1);

  const [clash] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.organizationId, ctx.organizationId), sql`lower(${products.name}) = lower(${name})`))
    .limit(1);
  if (clash && clash.id !== existing?.id) return { kind: "skipped", reason: PRODUCT_NAME_TAKEN };

  let productId: string;
  let hasPhotos = false;
  if (existing) {
    productId = existing.id;
    // nunca religa sozinho o que a equipe desligou: só o WhatsApp pode desligar
    await tx
      .update(products)
      .set({ name, description, priceCents: item.priceCents, available: existing.available && item.available, updatedAt: new Date() })
      .where(and(eq(products.organizationId, ctx.organizationId), eq(products.id, existing.id)));
    const [photo] = await tx.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, existing.id)).limit(1);
    hasPhotos = Boolean(photo);
  } else {
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.organizationId, ctx.organizationId));
    if ((count?.n ?? 0) >= CATALOG_LIMITS.maxProducts) return { kind: "skipped", reason: CATALOG_FULL };
    productId = newId();
    await tx.insert(products).values({
      id: productId,
      organizationId: ctx.organizationId,
      name,
      description,
      priceCents: item.priceCents,
      available: item.available,
      source: "whatsapp",
      externalId: item.externalId,
      channelId,
      createdBy: ctx.userId,
    });
  }

  if (!hasPhotos) {
    const now = new Date();
    for (const [position, photo] of photos.entries()) {
      await tx.insert(mediaFiles).values({
        id: photo.id,
        organizationId: ctx.organizationId,
        kind: "image",
        fileName: photo.fileName,
        mimeType: photo.mimeType,
        sizeBytes: photo.sizeBytes,
        storageKey: photo.storageKey,
        thumbKey: photo.thumbKey,
        status: "ready",
        direction: "out",
        createdBy: ctx.userId,
        createdAt: now,
        readyAt: now,
      });
      await tx.insert(productImages).values({ id: newId(), organizationId: ctx.organizationId, productId, mediaId: photo.id, position });
    }
  }
  return { kind: existing ? "updated" : "created" };
}

export type ImportError = "channel_not_found" | "channel_disconnected" | "not_business" | "provider_unavailable";

/**
 * Importa produtos do catálogo do WhatsApp (os marcados, ou todos). Um produto por vez: cada um entra numa transação própria,
 * então o que falhar não desfaz os outros. Em `all`, os já importados que saíram do catálogo do WhatsApp são desligados.
 */
export async function importWhatsappProducts(
  run: RunInTenant,
  ctx: CatalogCtx,
  input: WhatsappImportInput,
  deps: WhatsappCatalogDeps,
  rt: MediaRuntime = getMediaRuntime(),
  fetchImage: ImageFetcher = createImageFetcher(),
): Promise<Result<WhatsappImportResult, ImportError>> {
  const rows = await run((tx) => listQrChannels(tx, ctx.organizationId));
  const channel = rows.find((r) => r.id === input.channelId);
  if (!channel) return fail("channel_not_found", "WhatsApp não encontrado.");
  const read = await readProviderCatalog(channel, deps);
  if (read.state === "channel_disconnected") return fail("channel_disconnected", "Este WhatsApp está desconectado. Reconecte o canal em Canais e tente de novo.");
  if (read.state === "not_business") return fail("not_business", "Este número não é do WhatsApp Business, então não tem catálogo.");
  if (read.state === "unavailable") return fail("provider_unavailable", "Não conseguimos ler o catálogo do WhatsApp agora. Tente de novo em alguns instantes.");

  const all = read.catalog.products;
  const wanted = input.all ? new Set(all.map((p) => p.externalId)) : new Set(input.externalIds ?? []);
  const result: WhatsappImportResult = { created: 0, updated: 0, turnedOff: 0, skipped: [] };

  const byId = new Map(all.map((p) => [p.externalId, p]));
  for (const externalId of wanted) {
    const item = byId.get(externalId);
    if (!item) {
      result.skipped.push({ externalId, name: externalId, reason: "Este produto não está mais no catálogo do WhatsApp." });
      continue;
    }
    // só baixa as fotos se o produto ainda não tem (evita baixar de novo a cada atualização)
    const needsPhotos = await run(async (tx) => {
      const [existing] = await tx
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.organizationId, ctx.organizationId), eq(products.channelId, channel.id), eq(products.externalId, externalId)))
        .limit(1);
      if (!existing) return true;
      const [photo] = await tx.select({ id: productImages.id }).from(productImages).where(eq(productImages.productId, existing.id)).limit(1);
      return !photo;
    });
    const photos = needsPhotos ? await downloadPhotos(item.imageUrls, ctx.organizationId, rt, fetchImage) : [];
    let outcome: OneOutcome;
    try {
      outcome = await run((tx) => upsertOne(tx, ctx, channel.id, item, photos));
    } catch {
      deps.log.warn("catalog.whatsapp.import_failed", { channelId: channel.id });
      outcome = { kind: "skipped", reason: "Não foi possível salvar este produto. Tente de novo." };
    }
    if (outcome.kind === "skipped") {
      // as fotos baixadas não foram ligadas a nada: sai do armazenamento
      await rt.storage?.deleteMany(keysOf(photos)).catch(() => {});
      result.skipped.push({ externalId, name: item.name, reason: outcome.reason });
    } else if (outcome.kind === "created") {
      result.created++;
    } else {
      result.updated++;
    }
  }

  if (input.all) {
    result.turnedOff = await run(async (tx) => {
      const ids = all.map((p) => p.externalId);
      const gone = await tx
        .update(products)
        .set({ available: false, updatedAt: new Date() })
        .where(
          and(
            eq(products.organizationId, ctx.organizationId),
            eq(products.channelId, channel.id),
            eq(products.source, "whatsapp"),
            eq(products.available, true),
            ids.length > 0 ? notInArray(products.externalId, ids) : sql`true`,
          ),
        )
        .returning({ id: products.id });
      return gone.length;
    });
  }
  return ok(result);
}
