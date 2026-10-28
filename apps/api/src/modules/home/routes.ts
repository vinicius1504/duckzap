import { homePeriodSchema } from "@duckzap/contracts/home";
import { can } from "@duckzap/contracts/permissions";
import type { Transaction } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { withOrgRealtime } from "../../lib/realtime";
import { idParam, jsonLimit, moduleErrorHandler, parseWith, readJson, requestCtx, tenantGuard, unwrap, type ModuleContext } from "../conversations/http";
import * as service from "./service";

/**
 * Rotas do Início. Todo membro vê o Início; os números de conversas respeitam a visibilidade do inbox (sem
 * `conversation.view_all` só entram as conversas que a pessoa alcança) e o ranking por atendente exige `home.view_team_metrics`.
 *
 *   GET   /home/overview?period=today|7d|30d|custom   KPIs, atenção, gráficos, tarefas
 *   POST  /home/tasks                                  { title } → tarefa da própria pessoa
 *   PATCH /home/tasks/:id                              { done }
 */
const periodQuerySchema = z.object({ period: homePeriodSchema.catch("today").default("today") });
const taskBodySchema = z.object({ title: z.string().trim().min(1, "Escreva a tarefa antes de adicionar.").max(200) });
const doneBodySchema = z.object({ done: z.boolean() });

export function homeRoutes(deps: Deps) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);

  const homeCtx = (c: ModuleContext): service.HomeCtx => {
    const ctx = requestCtx(c);
    return {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      timeZone: ctx.timeZone,
      orgName: ctx.orgName,
      canViewAll: can(ctx.role, "conversation.view_all"),
      canViewTeamMetrics: can(ctx.role, "home.view_team_metrics"),
      sendingPaused: ctx.sendingPaused,
    };
  };
  const run = <T>(c: ModuleContext, fn: (tx: Transaction, ctx: service.HomeCtx) => Promise<T>) => {
    const ctx = homeCtx(c);
    return withOrgRealtime(deps.db, ctx.organizationId, (tx) => fn(tx, ctx));
  };

  app.get("/home/overview", guard, async (c) => {
    const { period } = parseWith(periodQuerySchema, c.req.query());
    return c.json(await run(c, (tx, ctx) => service.getHomeOverview(tx, ctx, period)));
  });

  app.post("/home/tasks", guard, jsonLimit, async (c) => {
    const body = await readJson(c, taskBodySchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.createTask(tx, ctx, body.title))), 201);
  });

  app.patch("/home/tasks/:id", guard, jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, doneBodySchema);
    unwrap(await run(c, (tx, ctx) => service.setTaskDone(tx, ctx, id, body.done)));
    return c.json({ ok: true });
  });

  return app;
}
