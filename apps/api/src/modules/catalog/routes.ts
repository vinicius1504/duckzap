import { productAvailabilitySchema, productImageAttachSchema, productInputSchema } from "@duckzap/contracts/catalog";
import type { Transaction } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppBindings, Deps } from "../../lib/context";
import { withOrgRealtime } from "../../lib/realtime";
import { ApiError, idParam, jsonLimit, moduleErrorHandler, permit, readJson, requestCtx, tenantGuard, type ModuleContext } from "../contacts/http";
import type { Fail } from "../contacts/result";
import * as service from "./service";

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
 *
 * A foto sobe pelo fluxo normal de mídia (`POST /media/uploads` + `/complete`) e só depois é ligada ao produto.
 */

const STATUS: Record<string, ContentfulStatusCode> = {
  not_found: 404,
  name_taken: 409,
  catalog_full: 409,
  too_many_images: 409,
  invalid_media: 422,
};

function unwrap<T>(result: { ok: true; data: T } | Fail): T {
  if (result.ok) return result.data;
  throw new ApiError(STATUS[result.error] ?? 422, result.error, result.message);
}

export function catalogRoutes(deps: Deps) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
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

  return app;
}
