import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { publicApiParts } from "./auth";
import type { AppBindings, Deps } from "./lib/context";
import { normalizeValidationErrors, openApiValidationHook } from "./lib/http-validation";
import { onError, onNotFound } from "./middleware/error-handler";
import { originGuard } from "./middleware/origin-guard";
import { requireAuth } from "./middleware/require-auth";
import { healthRoutes } from "./routes/health";
import { mountModules } from "./modules";

export function createApp(deps: Deps) {
  const app = new OpenAPIHono<AppBindings>({ defaultHook: openApiValidationHook });

  app.use("*", requestId());
  app.use("*", secureHeaders());
  // validação de rotas declaradas (createRoute) nos sub-apps: 422 no formato { error: { code, message, fields } }
  app.use("/v1/*", normalizeValidationErrors);
  app.use(
    "/v1/*",
    cors({
      origin: deps.env.WEB_ORIGINS,
      credentials: true,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // CSRF: métodos que alteram dado exigem Origin permitido (WEB_ORIGINS/ADMIN_ORIGINS); roda depois do CORS e antes de tudo
  app.use("/v1/*", originGuard(deps));

  // Better Auth: login, cadastro, sessão, senha, organizações, 2FA
  // o Better Auth conhece as rotas pelo caminho público (com o prefixo do proxy), então devolvemos o prefixo
  const { prefix } = publicApiParts(deps.env);
  app.on(["GET", "POST"], "/v1/auth/*", (c) => {
    const url = new URL(c.req.url);
    url.pathname = `${prefix}${url.pathname}`;
    return deps.auth.handler(new Request(url, c.req.raw));
  });

  app.route("/v1", healthRoutes);
  mountModules(app, deps);

  // O documento expõe a superfície da API: só com sessão (ou OPENAPI_PUBLIC=true em dev/documentação)
  if (!deps.env.OPENAPI_PUBLIC) app.use("/openapi.json", requireAuth(deps));
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Duckzap API", version: "1.0.0" },
  });

  app.onError(onError);
  app.notFound(onNotFound);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
