import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Sistema"],
  responses: {
    200: {
      description: "API no ar",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok"), uptime: z.number() }),
        },
      },
    },
  },
});

export const healthRoutes = new OpenAPIHono().openapi(healthRoute, (c) =>
  c.json({ status: "ok" as const, uptime: process.uptime() }, 200),
);
