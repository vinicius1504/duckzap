import { productAvailabilitySchema, productImageAttachSchema, productInputSchema, whatsappImportSchema } from "@duckzap/contracts/catalog";
import type { Transaction } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppBindings, Deps } from "../../lib/context";
import { withOrgRealtime } from "../../lib/realtime";
import { InMemoryTokenBucket, type RateLimiter } from "../channels/rate-limit";
import { getChannelsRuntime } from "../channels/runtime";
import { ApiError, idParam, jsonLimit, moduleErrorHandler, permit, readJson, requestCtx, tenantGuard, type ModuleContext } from "../contacts/http";
import type { Fail } from "../contacts/result";
import * as service from "./service";
import { createImageFetcher, importWhatsappProducts, loadWhatsappCatalog, type ImageFetcher, type WhatsappCatalogDeps } from "./whatsapp";

/**
 * Catálogo de produtos (contrato: packages/contracts/src/catalog.ts). Rotas finas; a regra está em `service.ts`.
 *
 *   GET    /catalog/products                          lista (com fotos assinadas)             qualquer pessoa da equipe
 *   POST   /catalog/products                          cadastra                                catalog.manage
 *   PATCH  /catalog/products/:id                      edita nome, descrição, valor, disponib.  catalog.manage
 *   POST   /catalog/products/:id/availability         liga/desliga a oferta pela IA            catalog.manage
 *   DELETE /catalog/products/:id                      apaga o produto e as fotos               catalog.manage
 *   POST   /catalog/products/:id/images               liga uma foto já enviada (mediaId)       catalog.manage
 *   DELETE /catalog/products/:id/images/:imageId      remove a foto                            catalog.manage
 *   GET    /catalog/whatsapp?channelId=               catálogo do WhatsApp Business do canal   catalog.manage
 *   POST   /catalog/whatsapp/import                   copia produtos do WhatsApp para o sistema catalog.manage
 *
 * A foto sobe pelo fluxo normal de mídia (`POST /media/uploads` + `/complete`) e só depois é ligada ao produto.
 * Produto do WhatsApp (`source = whatsapp`) é somente leitura: só a disponibilidade e a exclusão valem.
 */

const STATUS: Record<string, ContentfulStatusCode> = {
  not_found: 404,
  channel_not_found: 404,
  name_taken: 409,
  catalog_full: 409,
  too_many_images: 409,
  read_only: 409,
  channel_disconnected: 409,
  not_business: 409,
  invalid_media: 422,
  provider_unavailable: 503,
};

/** Ler ou importar o catálogo do WhatsApp chama o provedor (lento): poucas vezes por minuto, por empresa. */
export const WHATSAPP_CATALOG_CALLS_PER_MINUTE = 10;

export type CatalogRouteOptions = {
  /** Provedores de WhatsApp (padrão: o runtime de Canais, lido a cada pedido). Testes injetam um provedor falso. */
  whatsapp?: () => WhatsappCatalogDeps;
  /** Baixa as fotos do WhatsApp (padrão: só hosts do WhatsApp). Testes injetam um falso. */
  fetchImage?: ImageFetcher;
  whatsappLimiter?: RateLimiter;
};

function unwrap<T>(result: { ok: true; data: T } | Fail): T {
  if (result.ok) return result.data;
  throw new ApiError(STATUS[result.error] ?? 422, result.error, result.message);
}

export function catalogRoutes(deps: Deps, options: CatalogRouteOptions = {}) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
  const whatsappDeps = options.whatsapp ?? (() => getChannelsRuntime());
  const fetchImage = options.fetchImage ?? createImageFetcher();
  const whatsappLimiter =
    options.whatsappLimiter ?? new InMemoryTokenBucket({ capacity: WHATSAPP_CATALOG_CALLS_PER_MINUTE, refillPerSecond: WHATSAPP_CATALOG_CALLS_PER_MINUTE / 60 });
  const limit = async (organizationId: string) => {
    const taken = await whatsappLimiter.take(organizationId);
    if (!taken.allowed) {
      throw new ApiError(429, "rate_limited", "Você consultou o WhatsApp muitas vezes seguidas. Aguarde um minuto e tente de novo.", {
        retryAfterSeconds: Math.ceil(taken.retryAfterMs / 1000),
      });
    }
  };
  const run = <T>(c: ModuleContext, fn: (tx: Transaction, ctx: service.CatalogCtx) => Promise<T>) => {
    const ctx = requestCtx(c);
    const catalogCtx = { organizationId: ctx.organizationId, userId: ctx.userId };
    return withOrgRealtime(deps.db, ctx.organizationId, (tx) => fn(tx, catalogCtx));
  };

  app.get("/catalog/products", guard, async (c) => c.json(await run(c, (tx, ctx) => service.listProducts(tx, ctx))));

  app.post("/catalog/products", guard, permit("catalog.manage"), jsonLimit, async (c) => {
    const body = await readJson(c, productInputSchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.createProduct(tx, ctx, body))), 201);
  });

  app.patch("/catalog/products/:id", guard, permit("catalog.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, productInputSchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.updateProduct(tx, ctx, id, body))));
  });

  app.post("/catalog/products/:id/availability", guard, permit("catalog.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, productAvailabilitySchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.setAvailability(tx, ctx, id, body.available))));
  });

  app.delete("/catalog/products/:id", guard, permit("catalog.manage"), async (c) => {
    const id = idParam(c);
    return c.json(unwrap(await run(c, (tx, ctx) => service.deleteProduct(tx, ctx, id))));
  });

  app.post("/catalog/products/:id/images", guard, permit("catalog.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, productImageAttachSchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.attachImage(tx, ctx, id, body.mediaId))), 201);
  });

  app.delete("/catalog/products/:id/images/:imageId", guard, permit("catalog.manage"), async (c) => {
    const id = idParam(c);
    const imageId = idParam(c, "imageId");
    return c.json(unwrap(await run(c, (tx, ctx) => service.removeImage(tx, ctx, id, imageId))));
  });

  // Catálogo do WhatsApp Business: a chamada ao provedor fica fora da transação; cada trecho do banco abre a sua.
  const tenant = (c: ModuleContext) => {
    const ctx = requestCtx(c);
    return { catalogCtx: { organizationId: ctx.organizationId, userId: ctx.userId }, runInTenant: <T>(fn: (tx: Transaction) => Promise<T>) => withOrgRealtime(deps.db, ctx.organizationId, fn) };
  };

  app.get("/catalog/whatsapp", guard, permit("catalog.manage"), async (c) => {
    const { catalogCtx, runInTenant } = tenant(c);
    await limit(catalogCtx.organizationId);
    const channelId = c.req.query("channelId")?.trim() || undefined;
    return c.json(unwrap(await loadWhatsappCatalog(runInTenant, catalogCtx, { channelId }, whatsappDeps())));
  });

  app.post("/catalog/whatsapp/import", guard, permit("catalog.manage"), jsonLimit, async (c) => {
    const { catalogCtx, runInTenant } = tenant(c);
    await limit(catalogCtx.organizationId);
    const body = await readJson(c, whatsappImportSchema);
    return c.json(unwrap(await importWhatsappProducts(runInTenant, catalogCtx, body, whatsappDeps(), undefined, fetchImage)));
  });

  return app;
}
