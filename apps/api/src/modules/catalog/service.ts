import { CATALOG_FULL, CATALOG_LIMITS, PRODUCT_NAME_TAKEN, type Product, type ProductImage, type ProductInput, type ProductList } from "@duckzap/contracts/catalog";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isGuid } from "../contacts/http";
import { PG_UNIQUE_VIOLATION, fail, newId, ok, pgErrorCode, type Result } from "../contacts/result";
import { READ_URL_SECONDS } from "../media/logic";
import { getMediaRuntime, type MediaRuntime } from "../media/runtime";
import { discard } from "../media/service";

const { products, productImages, mediaFiles } = schema;

type ProductRow = typeof products.$inferSelect;
export type CatalogCtx = { organizationId: string; userId: string };
export type ProductInputData = Required<ProductInput>;

const NOT_FOUND = "Produto não encontrado.";

// ── leitura ─────────────────────────────────────────────────────────────────

/** Fotos (com URL assinada curta) dos produtos, agrupadas por produto e ordenadas por posição. Sem armazenamento: `url` null. */
async function imagesOf(tx: Transaction, organizationId: string, productIds: readonly string[], rt: MediaRuntime): Promise<Map<string, ProductImage[]>> {
  const out = new Map<string, ProductImage[]>();
  if (productIds.length === 0) return out;
  const rows = await tx
    .select({
      id: productImages.id,
      productId: productImages.productId,
      position: productImages.position,
      mediaId: mediaFiles.id,
      storageKey: mediaFiles.storageKey,
      thumbKey: mediaFiles.thumbKey,
      mimeType: mediaFiles.mimeType,
      status: mediaFiles.status,
    })
    .from(productImages)
    .innerJoin(mediaFiles, eq(mediaFiles.id, productImages.mediaId))
    .where(and(eq(productImages.organizationId, organizationId), inArray(productImages.productId, [...productIds])))
    .orderBy(asc(productImages.productId), asc(productImages.position));
  for (const row of rows) {
    let url: string | null = null;
    let thumbnailUrl: string | null = null;
    if (row.status === "ready" && rt.storage) {
      try {
        url = await rt.storage.presignGet(row.storageKey, { expiresInSeconds: READ_URL_SECONDS, contentType: row.mimeType });
        thumbnailUrl = row.thumbKey ? await rt.storage.presignGet(row.thumbKey, { expiresInSeconds: READ_URL_SECONDS, contentType: "image/webp" }).catch(() => null) : null;
      } catch {
        rt.log.warn("catalog.sign_failed", { mediaId: row.mediaId });
        url = null;
        thumbnailUrl = null;
      }
    }
    const list = out.get(row.productId) ?? [];
    list.push({ id: row.id, mediaId: row.mediaId, position: row.position, url, thumbnailUrl });
    out.set(row.productId, list);
  }
  return out;
}

function toProduct(row: ProductRow, images: ProductImage[]): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.priceCents,
    available: row.available,
    images,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function buildProducts(tx: Transaction, organizationId: string, rows: ProductRow[], rt: MediaRuntime): Promise<Product[]> {
  const images = await imagesOf(tx, organizationId, rows.map((r) => r.id), rt);
  return rows.map((row) => toProduct(row, images.get(row.id) ?? []));
}

async function findRow(tx: Transaction, organizationId: string, id: string, lock = false): Promise<ProductRow | undefined> {
  if (!isGuid(id)) return undefined;
  const query = tx
    .select()
    .from(products)
    .where(and(eq(products.organizationId, organizationId), eq(products.id, id)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row;
}

async function loadProduct(tx: Transaction, organizationId: string, row: ProductRow, rt: MediaRuntime): Promise<Product> {
  const [product] = await buildProducts(tx, organizationId, [row], rt);
  return product!;
}

export async function listProducts(tx: Transaction, ctx: CatalogCtx, rt: MediaRuntime = getMediaRuntime()): Promise<ProductList> {
  const rows = await tx.select().from(products).where(eq(products.organizationId, ctx.organizationId)).orderBy(sql`lower(${products.name})`, asc(products.id));
  return { products: await buildProducts(tx, ctx.organizationId, rows, rt), limit: CATALOG_LIMITS.maxProducts };
}

export async function getProduct(tx: Transaction, ctx: CatalogCtx, id: string, rt: MediaRuntime = getMediaRuntime()): Promise<Product | null> {
  const row = await findRow(tx, ctx.organizationId, id);
  return row ? loadProduct(tx, ctx.organizationId, row, rt) : null;
}

// ── cadastro ────────────────────────────────────────────────────────────────

type SaveError = "name_taken" | "catalog_full" | "not_found";

async function nameTaken(tx: Transaction, organizationId: string, name: string, exceptId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.organizationId, organizationId), sql`lower(${products.name}) = lower(${name})`))
    .limit(2);
  return rows.some((r) => r.id !== exceptId);
}

export async function createProduct(tx: Transaction, ctx: CatalogCtx, input: ProductInputData, rt: MediaRuntime = getMediaRuntime()): Promise<Result<Product, SaveError>> {
  // serializa os cadastros da empresa: dois pedidos ao mesmo tempo não passam juntos do limite
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`catalog:${ctx.organizationId}`}))`);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.organizationId, ctx.organizationId));
  if ((count?.n ?? 0) >= CATALOG_LIMITS.maxProducts) return fail("catalog_full", CATALOG_FULL);
  if (await nameTaken(tx, ctx.organizationId, input.name)) return fail("name_taken", PRODUCT_NAME_TAKEN);

  const id = newId();
  try {
    await tx.transaction(async (sp) => {
      await sp.insert(products).values({
        id,
        organizationId: ctx.organizationId,
        name: input.name,
        description: input.description,
        priceCents: input.priceCents,
        available: input.available,
        createdBy: ctx.userId,
      });
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return fail("name_taken", PRODUCT_NAME_TAKEN);
    throw error;
  }
  const row = await findRow(tx, ctx.organizationId, id);
  return ok(await loadProduct(tx, ctx.organizationId, row!, rt));
}

export async function updateProduct(tx: Transaction, ctx: CatalogCtx, id: string, input: ProductInputData, rt: MediaRuntime = getMediaRuntime()): Promise<Result<Product, SaveError>> {
  const current = await findRow(tx, ctx.organizationId, id, true);
  if (!current) return fail("not_found", NOT_FOUND);
  if (await nameTaken(tx, ctx.organizationId, input.name, id)) return fail("name_taken", PRODUCT_NAME_TAKEN);
  try {
    await tx.transaction(async (sp) => {
      await sp
        .update(products)
        .set({ name: input.name, description: input.description, priceCents: input.priceCents, available: input.available, updatedAt: new Date() })
        .where(and(eq(products.organizationId, ctx.organizationId), eq(products.id, id)));
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) return fail("name_taken", PRODUCT_NAME_TAKEN);
    throw error;
  }
  const row = await findRow(tx, ctx.organizationId, id);
  return ok(await loadProduct(tx, ctx.organizationId, row!, rt));
}

export async function setAvailability(tx: Transaction, ctx: CatalogCtx, id: string, available: boolean, rt: MediaRuntime = getMediaRuntime()): Promise<Result<Product, "not_found">> {
  const current = await findRow(tx, ctx.organizationId, id, true);
  if (!current) return fail("not_found", NOT_FOUND);
  await tx
    .update(products)
    .set({ available, updatedAt: new Date() })
    .where(and(eq(products.organizationId, ctx.organizationId), eq(products.id, id)));
  const row = await findRow(tx, ctx.organizationId, id);
  return ok(await loadProduct(tx, ctx.organizationId, row!, rt));
}

/** Apaga o produto e as fotos: objetos no armazenamento (original e miniatura) e os registros de `media_files`. */
export async function deleteProduct(tx: Transaction, ctx: CatalogCtx, id: string, rt: MediaRuntime = getMediaRuntime()): Promise<Result<{ ok: true }, "not_found">> {
  const current = await findRow(tx, ctx.organizationId, id, true);
  if (!current) return fail("not_found", NOT_FOUND);
  const files = await tx
    .select({ id: mediaFiles.id, storageKey: mediaFiles.storageKey, thumbKey: mediaFiles.thumbKey })
    .from(productImages)
    .innerJoin(mediaFiles, eq(mediaFiles.id, productImages.mediaId))
    .where(and(eq(productImages.organizationId, ctx.organizationId), eq(productImages.productId, id)));
  // o produto sai primeiro (cascata remove product_images); depois os arquivos
  await tx.delete(products).where(and(eq(products.organizationId, ctx.organizationId), eq(products.id, id)));
  await dropFiles(tx, ctx.organizationId, files, rt);
  return ok({ ok: true });
}

/** Apaga objetos (melhor esforço) e os registros de media_files. Registro sem objeto apagado ficaria órfão; por isso o registro só some se a remoção do objeto não lançar. */
async function dropFiles(tx: Transaction, organizationId: string, files: { id: string; storageKey: string; thumbKey: string | null }[], rt: MediaRuntime) {
  if (files.length === 0) return;
  const keys = files.flatMap((f) => (f.thumbKey ? [f.storageKey, f.thumbKey] : [f.storageKey]));
  try {
    await rt.storage?.deleteMany(keys);
  } catch {
    rt.log.error("catalog.delete_files_failed", { organizationId });
    // objeto ficou: marca como `deleted` para a limpeza oportunista (que também apaga o objeto) cuidar depois
    for (const f of files) await discard(tx, rt, f);
    return;
  }
  await tx.delete(mediaFiles).where(and(eq(mediaFiles.organizationId, organizationId), inArray(mediaFiles.id, files.map((f) => f.id))));
}

// ── fotos ───────────────────────────────────────────────────────────────────

type ImageError = "not_found" | "invalid_media" | "too_many_images";

/**
 * Liga ao produto uma foto enviada pelo fluxo normal de mídia. Mesmas regras de `claimForSend`: da empresa, enviada por
 * esta pessoa, imagem, `ready`, ainda sem mensagem e sem uso em outro produto. Trava a linha (FOR UPDATE).
 */
export async function attachImage(tx: Transaction, ctx: CatalogCtx, productId: string, mediaId: string, rt: MediaRuntime = getMediaRuntime()): Promise<Result<Product, ImageError>> {
  const product = await findRow(tx, ctx.organizationId, productId, true);
  if (!product) return fail("not_found", NOT_FOUND);
  const invalid = (message: string) => fail("invalid_media", message);
  if (!isGuid(mediaId)) return invalid("Arquivo não encontrado. Envie a foto de novo.");
  const [media] = await tx
    .select()
    .from(mediaFiles)
    .where(and(eq(mediaFiles.id, mediaId), eq(mediaFiles.organizationId, ctx.organizationId), eq(mediaFiles.direction, "out")))
    .limit(1)
    .for("update");
  if (!media || media.createdBy !== ctx.userId) return invalid("Arquivo não encontrado. Envie a foto de novo.");
  if (media.status !== "ready") return invalid("A foto ainda não foi conferida ou foi descartada. Envie de novo.");
  if (media.kind !== "image") return invalid("O arquivo precisa ser uma imagem.");
  if (media.messageId) return invalid("Este arquivo já foi usado em uma mensagem. Envie a foto de novo.");
  const [inUse] = await tx.select({ id: productImages.id }).from(productImages).where(eq(productImages.mediaId, mediaId)).limit(1);
  if (inUse) return invalid("Esta foto já está em um produto. Envie de novo.");

  const taken = await tx
    .select({ position: productImages.position })
    .from(productImages)
    .where(and(eq(productImages.organizationId, ctx.organizationId), eq(productImages.productId, productId)));
  if (taken.length >= CATALOG_LIMITS.maxImages) return fail("too_many_images", `Cada produto aceita até ${CATALOG_LIMITS.maxImages} fotos. Remova uma para enviar outra.`);
  const takenPositions = new Set(taken.map((t) => t.position));
  let position = 0;
  while (takenPositions.has(position)) position++;

  await tx.insert(productImages).values({ id: newId(), organizationId: ctx.organizationId, productId, mediaId, position });
  await tx
    .update(products)
    .set({ updatedAt: new Date() })
    .where(and(eq(products.organizationId, ctx.organizationId), eq(products.id, productId)));
  const row = await findRow(tx, ctx.organizationId, productId);
  return ok(await loadProduct(tx, ctx.organizationId, row!, rt));
}

/** Remove a foto (linha e arquivo) e fecha o buraco: a de menor posição vira a capa (0). */
export async function removeImage(tx: Transaction, ctx: CatalogCtx, productId: string, imageId: string, rt: MediaRuntime = getMediaRuntime()): Promise<Result<Product, "not_found">> {
  const product = await findRow(tx, ctx.organizationId, productId, true);
  if (!product || !isGuid(imageId)) return fail("not_found", product ? "Foto não encontrada." : NOT_FOUND);
  const [image] = await tx
    .select({ id: productImages.id, mediaId: productImages.mediaId, storageKey: mediaFiles.storageKey, thumbKey: mediaFiles.thumbKey })
    .from(productImages)
    .innerJoin(mediaFiles, eq(mediaFiles.id, productImages.mediaId))
    .where(and(eq(productImages.organizationId, ctx.organizationId), eq(productImages.productId, productId), eq(productImages.id, imageId)))
    .limit(1);
  if (!image) return fail("not_found", "Foto não encontrada.");

  await tx.delete(productImages).where(eq(productImages.id, image.id));
  await dropFiles(tx, ctx.organizationId, [{ id: image.mediaId, storageKey: image.storageKey, thumbKey: image.thumbKey }], rt);

  // reposiciona sem violar o índice único (product_id, position): uma linha por vez, sempre para uma posição livre mais baixa
  const rest = await tx
    .select({ id: productImages.id, position: productImages.position })
    .from(productImages)
    .where(and(eq(productImages.organizationId, ctx.organizationId), eq(productImages.productId, productId)))
    .orderBy(asc(productImages.position));
  for (const [index, row] of rest.entries()) {
    if (row.position !== index) await tx.update(productImages).set({ position: index }).where(eq(productImages.id, row.id));
  }
  await tx
    .update(products)
    .set({ updatedAt: new Date() })
    .where(and(eq(products.organizationId, ctx.organizationId), eq(products.id, productId)));
  const row = await findRow(tx, ctx.organizationId, productId);
  return ok(await loadProduct(tx, ctx.organizationId, row!, rt));
}
