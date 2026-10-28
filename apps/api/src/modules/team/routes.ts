import { inviteMemberInputSchema, teamInputSchema, updateMemberInputSchema } from "@duckzap/contracts/team";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings, Deps } from "../../lib/context";
import { fail, parseBody, withActor, type ActorBindings } from "./http";
import { acceptInvite, acceptInviteBodySchema, getInviteInfo } from "./invites";
import { rateLimitByIp } from "./rate-limit";
import type { Res } from "./result";
import * as service from "./service";


/**
 * Rotas finas de Equipe: autenticar → autorizar (`team.manage`) → validar → service → serializar.
 * Mapa:
 *   GET    /v1/team/overview                 pessoas, equipes, limite de usuários   (team.manage)
 *   POST   /v1/team/invites                  convida por e-mail                      (team.manage)
 *   POST   /v1/team/invites/:id/resend       reenvia o convite                       (team.manage)
 *   DELETE /v1/team/invites/:id              cancela o convite                       (team.manage)
 *   PATCH  /v1/team/members/:id              nome, papel e equipes                   (team.manage)
 *   POST   /v1/team/members/:id/password-reset  e-mail de redefinição               (team.manage)
 *   POST   /v1/team/members/:id/activate | /deactivate                              (team.manage)
 *   POST   /v1/team/teams · PATCH|DELETE /v1/team/teams/:id                          (team.manage)
 *   GET    /v1/invites/:token                dados do convite (público; o token do e-mail é `<id>.<assinatura>`)
 *   POST   /v1/invites/:token/accept         aceita (cria a conta se for pessoa nova) (público)
 */
export function teamRoutes(deps: Deps) {
  const app = new OpenAPIHono<ActorBindings>();

  app.use("/team/*", withActor(deps, "team.manage"));

  const respond = <T>(c: Parameters<typeof fail>[0], result: Res<T>, status: 200 | 201 = 200) =>
    result.ok ? c.json(result.data as object, status) : fail(c, result.error.status, result.error.code, result.error.message);

  app.get("/team/overview", async (c) => c.json(await service.getTeamOverview({ deps, actor: c.get("actor") })));

  app.post("/team/invites", async (c) => {
    const body = await parseBody(c, inviteMemberInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.inviteMember({ deps, actor: c.get("actor"), headers: c.req.raw.headers }, body.data), 201);
  });

  app.post("/team/invites/:id/resend", async (c) => {
    const result = await service.resendInvite({ deps, actor: c.get("actor"), headers: c.req.raw.headers }, c.req.param("id").slice(0, 64));
    return respond(c, result);
  });

  app.delete("/team/invites/:id", async (c) => {
    const result = await service.cancelInvite({ deps, actor: c.get("actor"), headers: c.req.raw.headers }, c.req.param("id").slice(0, 64));
    return respond(c, result);
  });

  app.patch("/team/members/:id", async (c) => {
    const body = await parseBody(c, updateMemberInputSchema);
    if (!body.ok) return body.response;
    const result = await service.updateMember(
      { deps, actor: c.get("actor"), headers: c.req.raw.headers },
      c.req.param("id").slice(0, 64),
      body.data,
    );
    return respond(c, result);
  });

  app.post("/team/members/:id/password-reset", async (c) => {
    const result = await service.resetMemberPassword(
      { deps, actor: c.get("actor"), headers: c.req.raw.headers },
      c.req.param("id").slice(0, 64),
    );
    return respond(c, result);
  });

  for (const [path, active] of [
    ["activate", true],
    ["deactivate", false],
  ] as const) {
    app.post(`/team/members/:id/${path}`, async (c) => {
      const result = await service.setMemberActive(
        { deps, actor: c.get("actor"), headers: c.req.raw.headers },
        c.req.param("id").slice(0, 64),
        active,
      );
      return result.ok ? c.json({ ok: true }) : fail(c, result.error.status, result.error.code, result.error.message);
    });
  }

  app.post("/team/teams", async (c) => {
    const body = await parseBody(c, teamInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.createTeam({ deps, actor: c.get("actor") }, body.data), 201);
  });

  app.patch("/team/teams/:id", async (c) => {
    const body = await parseBody(c, teamInputSchema);
    if (!body.ok) return body.response;
    return respond(c, await service.updateTeam({ deps, actor: c.get("actor") }, c.req.param("id").slice(0, 64), body.data));
  });

  app.delete("/team/teams/:id", async (c) => {
    const result = await service.deleteTeam({ deps, actor: c.get("actor") }, c.req.param("id").slice(0, 64));
    return result.ok ? c.json({ ok: true }) : fail(c, result.error.status, result.error.code, result.error.message);
  });

  // ---------- público: aceite de convite ----------
  app.use("/invites/*", rateLimitByIp({ windowMs: 60_000, max: 20, scope: "invites" }));

  app.get("/invites/:id", async (c) => respond(c, await getInviteInfo(deps, c.req.param("id").slice(0, 200))));

  app.post("/invites/:id/accept", async (c) => {
    const body = await parseBody(c, acceptInviteBodySchema);
    if (!body.ok) return body.response;
    const result = await acceptInvite(deps, {
      token: c.req.param("id").slice(0, 200),
      headers: c.req.raw.headers,
      password: body.data.password,
    });
    if (!result.ok) return fail(c, result.error.status, result.error.code, result.error.message);
    for (const cookie of result.data.setCookies) c.header("set-cookie", cookie, { append: true });
    return c.json({ organizationId: result.data.organizationId });
  });

  // o app interno carrega o `actor`; para fora, o tipo é o AppBindings comum dos módulos
  const outer = new OpenAPIHono<AppBindings>();
  outer.route("/", app);
  return outer;
}
