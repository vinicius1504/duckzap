import { sessionSchema } from "@duckzap/contracts/session";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppBindings, Deps } from "../../lib/context";
import { requireAuth } from "../../middleware/require-auth";
import { buildSession } from "./queries";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Sessão"],
  summary: "Sessão atual: pessoa, empresa ativa, papel e plano",
  responses: {
    200: { description: "Sessão", content: { "application/json": { schema: sessionSchema } } },
    401: { description: "Sem sessão", content: { "application/json": { schema: errorSchema } } },
    403: { description: "Conta sem empresa (cadastro incompleto)", content: { "application/json": { schema: errorSchema } } },
  },
});

export function sessionRoutes(deps: Deps) {
  const app = new OpenAPIHono<AppBindings>();
  app.use("/me", requireAuth(deps));
  return app.openapi(meRoute, async (c) => {
    const result = await buildSession(deps.db, c.get("authSession"));
    if (!result.ok) {
      return c.json(
        { error: { code: result.code, message: "Termine o cadastro da sua empresa para continuar." } },
        403,
      );
    }
    return c.json(result.session, 200);
  });
}
