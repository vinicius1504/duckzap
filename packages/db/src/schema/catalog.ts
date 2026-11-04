import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { channels } from "./channels";
import { mediaFiles } from "./media";

// Catálogo de produtos (V1): cadastro manual, até 3 fotos por produto, modelos diferentes = produtos separados.
// Ids: UUID v7 gerado pela aplicação. Contrato: packages/contracts/src/catalog.ts.

/**
 * Produto (ou serviço) que a empresa vende. `price_cents` null = "sob consulta" (a IA não cita valor).
 * `available = false` tira o produto da busca da IA, mas o cadastro fica.
 *
 * `source`: `system` (cadastrado aqui) ou `whatsapp` (copiado do catálogo do WhatsApp Business do canal `channel_id`;
 * `external_id` é o id do produto lá, para reimportar sem duplicar). Produto do WhatsApp é somente leitura no sistema
 * (só liga/desliga a oferta): quem edita é o app WhatsApp Business. Canal apagado solta o vínculo (SET NULL).
 */
export const products = pgTable(
  "products",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    description: text().notNull().default(""),
    priceCents: integer(),
    available: boolean().notNull().default(true),
    source: text({ enum: ["system", "whatsapp"] }).notNull().default("system"),
    externalId: text(),
    channelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    createdBy: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("products_org_idx").on(t.organizationId, t.available),
    uniqueIndex("products_org_name_unique").on(t.organizationId, sql`lower(${t.name})`),
    uniqueIndex("products_channel_external_unique").on(t.channelId, t.externalId).where(sql`${t.channelId} is not null and ${t.externalId} is not null`),
    check("products_source_check", sql`${t.source} in ('system', 'whatsapp')`),
    check("products_price_check", sql`${t.priceCents} is null or ${t.priceCents} between 0 and 1000000000`),
    check("products_description_check", sql`char_length(${t.description}) <= 500`),
    tenantPolicy("products", t.organizationId),
  ],
).enableRLS();

/**
 * Foto do produto: aponta para um arquivo de `media_files` (enviado pelo fluxo normal de mídia). `position` 0..2 (máx. 3
 * fotos); a de posição 0 é a capa. O arquivo da foto NUNCA é apagado pela limpeza de órfãos enquanto esta linha existir.
 */
export const productImages = pgTable(
  "product_images",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    mediaId: uuid()
      .notNull()
      .references(() => mediaFiles.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_images_product_position_unique").on(t.productId, t.position),
    uniqueIndex("product_images_media_unique").on(t.mediaId),
    index("product_images_org_idx").on(t.organizationId),
    check("product_images_position_check", sql`${t.position} between 0 and 2`),
    tenantPolicy("product_images", t.organizationId),
  ],
).enableRLS();
