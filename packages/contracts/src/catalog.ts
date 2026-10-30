import { z } from "zod";

// Catálogo de produtos (V1): cadastro manual feito pela empresa; a IA consulta, manda foto e deixa o interesse de compra
// como nota interna. Modelos diferentes (tamanho, cor) são produtos separados. Sem importação nem estoque numérico.

export const CATALOG_LIMITS = {
  /** Produtos por empresa (controla o custo de contexto da IA). */
  maxProducts: 100,
  maxImages: 3,
  nameMax: 80,
  descriptionMax: 500,
  /** R$ 10.000.000,00 em centavos. */
  maxPriceCents: 1_000_000_000,
} as const;

/** Foto do produto. `url`/`thumbnailUrl` são URLs assinadas CURTAS (minutos); null quando o armazenamento está indisponível. */
export const productImageSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  position: z.number().int().min(0).max(CATALOG_LIMITS.maxImages - 1),
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
});
export type ProductImage = z.infer<typeof productImageSchema>;

export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Em centavos. null = "sob consulta" (a IA não cita valor). */
  priceCents: z.number().int().min(0).nullable(),
  available: z.boolean(),
  images: z.array(productImageSchema),
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof productSchema>;

export const productListSchema = z.object({
  products: z.array(productSchema),
  limit: z.number().int(),
});
export type ProductList = z.infer<typeof productListSchema>;

export const productInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao produto.").max(CATALOG_LIMITS.nameMax, `Use até ${CATALOG_LIMITS.nameMax} caracteres no nome.`),
  description: z.string().trim().max(CATALOG_LIMITS.descriptionMax, `Use até ${CATALOG_LIMITS.descriptionMax} caracteres na descrição.`).default(""),
  priceCents: z
    .number()
    .int("Informe o valor em reais e centavos.")
    .min(0, "O valor não pode ser negativo.")
    .max(CATALOG_LIMITS.maxPriceCents, "Valor alto demais.")
    .nullable()
    .default(null),
  available: z.boolean().default(true),
});
export type ProductInput = z.input<typeof productInputSchema>;

/** Liga ao produto uma foto já enviada e conferida pelo fluxo de mídia (`POST /v1/media/uploads` + `/complete`). */
export const productImageAttachSchema = z.object({ mediaId: z.guid("Arquivo inválido.") });
export type ProductImageAttach = z.infer<typeof productImageAttachSchema>;

/** Troca só a disponibilidade (o interruptor da lista). */
export const productAvailabilitySchema = z.object({ available: z.boolean() });

export const PRODUCT_NAME_TAKEN = "Já existe um produto com esse nome. Use um nome diferente (ex.: inclua tamanho ou cor).";
export const CATALOG_FULL = `O catálogo chegou ao limite de ${CATALOG_LIMITS.maxProducts} produtos. Exclua algum para cadastrar outro.`;

/** "R$ 59,90" (pt-BR). Mesmo formato que a IA usa para falar o valor, então o guardrail de preço o reconhece. */
export function formatPriceBRL(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Lê o que a pessoa digitou ("59,90", "1.299,90", "R$ 59") em centavos; null se vazio ou inválido. */
export function parsePriceToCents(raw: string): number | null {
  const cleaned = raw.replace(/R\$|\s/g, "");
  if (!cleaned) return null;
  const normalized = cleaned.includes(",") ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents <= CATALOG_LIMITS.maxPriceCents ? cents : null;
}
