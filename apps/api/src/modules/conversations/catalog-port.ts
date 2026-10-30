import { PortError, formatPrice, type CatalogPort, type ProductInfo, type Scope } from "@duckzap/ai";
import { CATALOG_LIMITS } from "@duckzap/contracts/catalog";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { thumbnailKeyFor } from "../../lib/thumbnail";
import { isGuid } from "../contacts/http";
import { newId } from "../contacts/result";
import { storageKeyFor } from "../media/logic";
import { getMediaRuntime, type MediaRuntime } from "../media/runtime";
import { linkToMessage } from "../media/service";
import { deliverOutbound } from "./outbound";
import type { ConversationRow } from "./queries";

const { products, productImages, mediaFiles, messages } = schema;

/**
 * Catálogo para a IA (porta de leitura) e entrega das fotos dos produtos na conversa. Tudo escopado pela empresa da conversa:
 * o `Scope` que o runtime manda é conferido contra ela, e as consultas filtram `organization_id` além do RLS.
 */

/**
 * Fotos prontas (arquivo conferido) de cada produto: é o que a IA pode mandar. Escrito em SQL puro de propósito: numa seleção de
 * uma tabela só o Drizzle tira o prefixo das colunas (`"id"`), e dentro da subconsulta isso ficaria ambíguo.
 */
const READY_PHOTOS = sql<number>`(
  select count(*)::int from product_images pi
  join media_files m on m.id = pi.media_id
  where pi.product_id = products.id and m.status = 'ready' and m.kind = 'image'
)`;

function toInfo(row: { id: string; name: string; description: string; priceCents: number | null; photoCount: number }): ProductInfo {
  return { id: row.id, name: row.name, description: row.description, priceCents: row.priceCents, photoCount: row.photoCount };
}

export function createCatalogPort(env: { tx: Transaction; organizationId: string }): CatalogPort {
  const assertOrg = (scope: Scope) => {
    if (scope.organizationId !== env.organizationId) throw new PortError("forbidden", "Escopo inválido.");
  };
  const select = () =>
    env.tx
      .select({ id: products.id, name: products.name, description: products.description, priceCents: products.priceCents, photoCount: READY_PHOTOS })
      .from(products);

  return {
    async listAvailable(scope) {
      assertOrg(scope);
      const rows = await select()
        .where(and(eq(products.organizationId, env.organizationId), eq(products.available, true)))
        .orderBy(asc(products.name))
        .limit(CATALOG_LIMITS.maxProducts);
      return rows.map(toInfo);
    },

    async getProduct(scope, productId) {
      assertOrg(scope);
      if (!isGuid(productId)) return null;
      const [row] = await select()
        .where(and(eq(products.organizationId, env.organizationId), eq(products.id, productId), eq(products.available, true)))
        .limit(1);
      return row ? toInfo(row) : null;
    },
  };
}

/** A empresa tem ao menos um produto disponível? Liga as ferramentas de catálogo do turno. */
export async function hasAvailableProducts(tx: Transaction, organizationId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.organizationId, organizationId), eq(products.available, true)))
    .limit(1);
  return rows.length > 0;
}

// ---------- fotos ----------

/** Total de imagens que a IA manda num turno (2 produtos no máximo, fotos intercaladas) e teto por produto. */
export const MAX_PHOTOS_PER_TURN = 3;
export const MAX_PHOTOS_PER_PRODUCT = 2;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

type Photo = {
  productId: string;
  productName: string;
  priceCents: number | null;
  /** primeira foto do produto: leva a legenda (nome e valor) */
  first: boolean;
  file: typeof mediaFiles.$inferSelect;
};

/**
 * Escolhe as fotos a mandar: dos produtos pedidos (na ordem do pedido), uma de cada vez em rodadas (capa do 1º, capa do 2º,
 * segunda do 1º…), até `MAX_PHOTOS_PER_PRODUCT` por produto e `MAX_PHOTOS_PER_TURN` no total. Só produto disponível da empresa e arquivo `ready` do tipo imagem.
 */
export async function pickProductPhotos(tx: Transaction, organizationId: string, productIds: readonly string[]): Promise<Photo[]> {
  const ids = [...new Set(productIds.filter(isGuid))];
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ product: products, file: mediaFiles, position: productImages.position })
    .from(productImages)
    .innerJoin(products, eq(products.id, productImages.productId))
    .innerJoin(mediaFiles, eq(mediaFiles.id, productImages.mediaId))
    .where(
      and(
        eq(productImages.organizationId, organizationId),
        eq(products.organizationId, organizationId),
        eq(mediaFiles.organizationId, organizationId),
        eq(products.available, true),
        eq(mediaFiles.status, "ready"),
        eq(mediaFiles.kind, "image"),
        inArray(products.id, ids),
      ),
    )
    .orderBy(asc(productImages.position));

  const byProduct = new Map<string, typeof rows>();
  for (const id of ids) byProduct.set(id, rows.filter((r) => r.product.id === id));
  const picked: Photo[] = [];
  for (let round = 0; round < MAX_PHOTOS_PER_PRODUCT && picked.length < MAX_PHOTOS_PER_TURN; round++) {
    let any = false;
    for (const id of ids) {
      const row = byProduct.get(id)?.[round];
      if (!row) continue;
      any = true;
      if (picked.length >= MAX_PHOTOS_PER_TURN) break;
      picked.push({ productId: id, productName: row.product.name, priceCents: row.product.priceCents, first: round === 0, file: row.file });
    }
    if (!any) break;
  }
  return picked;
}

export type SendPhotosInput = {
  conv: ConversationRow;
  channelName: string;
  to: string | null;
  agent: { id: string; name: string };
  productIds: readonly string[];
  /** Id da mensagem do cliente que disparou o turno: o `externalId` das fotos é determinístico a partir dele. */
  triggerId: string | null;
  now: Date;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
};

const captionOf = (p: Photo) => (p.first ? `${p.productName} — ${p.priceCents === null ? "valor sob consulta" : formatPrice(p.priceCents)}` : "");

/**
 * Manda as fotos pedidas pela IA, depois dos textos. Cada foto é uma CÓPIA do arquivo do catálogo (novo `media_files` e novo
 * objeto no armazenamento, ligado à mensagem): o registro da mensagem é dono do arquivo dela, então apagar ou trocar a foto
 * do produto, ou limpar mídia de conversa, nunca mexe em uma no outro.
 *
 * Idempotente: o `externalId` é `ai:<conversa>:<gatilho>:photo:<n>`; se a mensagem já existe, a foto é pulada ANTES de copiar.
 * Falha de armazenamento numa foto (fora do ar, objeto sumido) não derruba o turno: o texto já foi e a foto é pulada.
 * Devolve quantas fotos foram entregues ao canal.
 */
export async function sendProductPhotos(tx: Transaction, input: SendPhotosInput, rt: MediaRuntime = getMediaRuntime()): Promise<number> {
  const { conv } = input;
  if (input.productIds.length === 0) return 0;
  const storage = rt.storage;
  if (!storage) {
    input.log.warn("conversations.ai.photos_skipped", { conversationId: conv.id, reason: "storage_unavailable" });
    return 0;
  }
  const photos = await pickProductPhotos(tx, conv.organizationId, input.productIds);
  let delivered = 0;
  for (const [n, photo] of photos.entries()) {
    const externalId = `ai:${conv.id}:${input.triggerId ?? "x"}:photo:${n}`;
    const [existing] = await tx
      .select({ id: messages.id, status: messages.status })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.externalId, externalId)))
      .limit(1);
    if (existing) {
      if (existing.status !== "failed") delivered++;
      continue;
    }

    // 1) armazenamento: copia a foto (e a miniatura). Falhar aqui só pula a foto; o banco ainda não foi tocado
    const keys: string[] = [];
    let copy: { storageKey: string; thumbKey: string | null } | null = null;
    try {
      const bytes = await storage.getObject(photo.file.storageKey, { maxBytes: photo.file.sizeBytes + 1024 });
      if (!bytes) throw new Error("objeto da foto não encontrado");
      const storageKey = storageKeyFor(conv.organizationId, input.now);
      await storage.put(storageKey, bytes, { contentType: photo.file.mimeType });
      keys.push(storageKey);
      // a miniatura acompanha a cópia (o balão carrega ela); sem miniatura a original serve
      let thumbKey: string | null = null;
      if (photo.file.thumbKey) {
        const thumb = await storage.getObject(photo.file.thumbKey, { maxBytes: MAX_THUMB_BYTES }).catch(() => null);
        if (thumb) {
          thumbKey = thumbnailKeyFor(storageKey);
          await storage.put(thumbKey, thumb, { contentType: "image/webp" });
          keys.push(thumbKey);
        }
      }
      copy = { storageKey, thumbKey };
    } catch (error) {
      if (keys.length > 0) await storage.deleteMany(keys).catch(() => undefined);
      input.log.warn("conversations.ai.photo_failed", { conversationId: conv.id, productId: photo.productId, error: error instanceof Error ? error.name : "unknown" });
      continue;
    }

    // 2) banco + envio, na transação do turno (sem savepoint: os avisos de tempo real são da transação do turno).
    // Erro de banco aqui desfaz o turno inteiro, como qualquer outra escrita dele; os objetos copiados saem para não ficarem sem dono.
    try {
      const copyId = newId();
      await tx.insert(mediaFiles).values({
        id: copyId,
        organizationId: conv.organizationId,
        kind: "image",
        fileName: photo.file.fileName,
        mimeType: photo.file.mimeType,
        sizeBytes: photo.file.sizeBytes,
        storageKey: copy.storageKey,
        thumbKey: copy.thumbKey,
        status: "ready",
        direction: "out",
        createdBy: null,
        createdAt: input.now,
        readyAt: input.now,
      });
      const result = await deliverOutbound(tx, {
        conv,
        channelName: input.channelName,
        to: input.to,
        kind: "image",
        body: captionOf(photo),
        media: { fileName: photo.file.fileName, mimeType: photo.file.mimeType, sizeBytes: photo.file.sizeBytes, durationSeconds: null, url: null, mediaId: copyId },
        sender: { kind: "agent", id: input.agent.id, name: input.agent.name },
        externalId,
        countsAsReply: true,
        now: input.now,
      });
      await linkToMessage(tx, copyId, result.message.id);
      if (result.ok) delivered++;
    } catch (error) {
      await storage.deleteMany(keys).catch(() => undefined);
      throw error;
    }
  }
  return delivered;
}
