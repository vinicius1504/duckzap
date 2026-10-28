import { mediaUploadInitSchema } from "@duckzap/contracts/media";
import { withOrg } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings, Deps } from "../../lib/context";
import { ApiError, idParam, jsonLimit, moduleErrorHandler, permit, readJson, requestCtx, tenantGuard, type ModuleContext } from "../conversations/http";
import { getMediaRuntime, setMediaRuntime, type MediaRuntime } from "./runtime";
import * as service from "./service";

/**
 * Mídia de conversa (contrato: packages/contracts/src/media.ts). Rotas finas; toda a regra está em `service.ts`/`logic.ts`.
 *
 *   POST /media/uploads                       valida tipo/tamanho e devolve a URL assinada de PUT   conversation.reply
 *   POST /media/uploads/:mediaId/complete     confere tamanho e tipo REAL (magic bytes) do objeto    conversation.reply
 *
 * O navegador envia o arquivo DIRETO ao armazenamento (nunca pela API) e não recebe credencial nenhuma. Limite de taxa por empresa.
 */

const STATUS: Record<string, 400 | 403 | 404 | 409 | 422 | 429 | 502 | 503> = {
  media_unavailable: 503,
  sending_paused: 403,
  invalid_media: 422,
  too_many_uploads: 429,
  not_found: 404,
  not_uploaded: 409,
};

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string; message: string }): T {
  if (result.ok) return result.data;
  throw new ApiError(STATUS[result.error] ?? 422, result.error, result.message);
}

export type MediaRouteOverrides = { runtime?: MediaRuntime };

export function mediaRoutes(deps: Deps, overrides: MediaRouteOverrides = {}) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
  if (overrides.runtime) setMediaRuntime(overrides.runtime);

  const ctxOf = (c: ModuleContext) => {
    const ctx = requestCtx(c);
    return { organizationId: ctx.organizationId, userId: ctx.userId, sendingPaused: ctx.sendingPaused };
  };
  const limit = async (c: ModuleContext, which: "initLimiter" | "completeLimiter") => {
    const taken = await getMediaRuntime()[which].take(requestCtx(c).organizationId);
    if (!taken.allowed) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(taken.retryAfterMs / 1000))));
      throw new ApiError(429, "rate_limited", "Muitos envios de arquivo seguidos. Aguarde alguns segundos e tente de novo.");
    }
  };

  app.post("/media/uploads", guard, permit("conversation.reply"), jsonLimit, async (c) => {
    await limit(c, "initLimiter");
    const body = await readJson(c, mediaUploadInitSchema);
    const ctx = ctxOf(c);
    const result = unwrap(await withOrg(deps.db, ctx.organizationId, (tx) => service.createUpload(tx, ctx, body)));
    return c.json(result, 201);
  });

  app.post("/media/uploads/:mediaId/complete", guard, permit("conversation.reply"), async (c) => {
    await limit(c, "completeLimiter");
    const mediaId = idParam(c, "mediaId");
    const ctx = ctxOf(c);
    return c.json(unwrap(await withOrg(deps.db, ctx.organizationId, (tx) => service.completeUpload(tx, ctx, mediaId))));
  });

  return app;
}
