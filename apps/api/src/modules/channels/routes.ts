import {
  assignTeamChannelsInputSchema,
  channelSchema,
  channelsOverviewSchema,
  createChannelInputSchema,
  officialCredentialsInputSchema,
  officialWebhookInfoSchema,
  qrSessionSchema,
  rotateWebhookTokenResultSchema,
  updateChannelSettingsInputSchema,
} from "@duckzap/contracts/channels";
import { can } from "@duckzap/contracts/permissions";
import type { Session } from "@duckzap/contracts/session";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppBindings, Deps } from "../../lib/context";
import { accessGate } from "../../middleware/account-gate";
import { requireAuth } from "../../middleware/require-auth";
import { buildSession } from "../session/queries";
import { onError } from "../../middleware/error-handler";
import { isUniqueViolation } from "./repo";
import { createChannelsRuntime, setChannelsRuntime, type ChannelsRuntime } from "./runtime";
import * as service from "./service";
import { databasePorts, handleWebhook } from "./webhook";

const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const okSchema = z.object({ ok: z.literal(true) });
const idParam = z.object({ id: z.string().min(1).max(64) });
const tags = ["Canais"];

const errorResponses = {
  401: { description: "Sem sessão", content: { "application/json": { schema: errorSchema } } },
  403: { description: "Sem permissão ou limite do plano", content: { "application/json": { schema: errorSchema } } },
  404: { description: "Não existe (ou é de outra empresa)", content: { "application/json": { schema: errorSchema } } },
  409: { description: "Conflito", content: { "application/json": { schema: errorSchema } } },
  422: { description: "Dados inválidos", content: { "application/json": { schema: errorSchema } } },
  502: { description: "Provedor indisponível", content: { "application/json": { schema: errorSchema } } },
} as const;

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

type Method = "get" | "post" | "patch" | "delete";
const responsesFor = <S extends z.ZodType>(response: S) => ({ 200: json(response, "OK"), ...errorResponses });
const jsonBody = <S extends z.ZodType>(schema: S) => ({ content: { "application/json": { schema } }, required: true as const });

const plainRoute = <M extends Method, P extends string, S extends z.ZodType>(method: M, path: P, summary: string, response: S) =>
  createRoute({ method, path, tags, summary, responses: responsesFor(response) });
const bodyRoute = <M extends Method, P extends string, B extends z.ZodType, S extends z.ZodType>(method: M, path: P, summary: string, body: B, response: S) =>
  createRoute({ method, path, tags, summary, request: { body: jsonBody(body) }, responses: responsesFor(response) });
const idRoute = <M extends Method, P extends string, S extends z.ZodType>(method: M, path: P, summary: string, response: S) =>
  createRoute({ method, path, tags, summary, request: { params: idParam }, responses: responsesFor(response) });
const idBodyRoute = <M extends Method, P extends string, B extends z.ZodType, S extends z.ZodType>(method: M, path: P, summary: string, body: B, response: S) =>
  createRoute({ method, path, tags, summary, request: { params: idParam, body: jsonBody(body) }, responses: responsesFor(response) });

/** Códigos de resultado do service → status HTTP (`{ error: { code, message } }`, §backend-conventions). */
const statusFor: Record<string, 403 | 404 | 409 | 422 | 502> = {
  not_found: 404,
  plan_limit: 403,
  type_not_allowed: 403,
  duplicate_name: 409,
  wrong_type: 409,
  is_default: 409,
  not_whatsapp: 422,
  invalid_link: 422,
  invalid_credentials: 422,
  unavailable: 502,
};

/** Erro com status e código próprios (vira `{ error: { code, message } }` no `onError` deste módulo). */
class ChannelsHttpError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409 | 422 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Resultado do service → dado de sucesso, ou erro HTTP com o status do código. */
function unwrap<T>(result: service.Res<T, string>): T {
  if (result.ok) return result.data;
  throw new ChannelsHttpError(statusFor[result.code] ?? 422, result.code, result.message);
}

export function channelsRoutes(deps: Deps, overrides: Partial<ChannelsRuntime> = {}) {
  // configuração inválida derruba o boot (§5.3)
  const rt = createChannelsRuntime(overrides);
  setChannelsRuntime(rt);

  const app = new OpenAPIHono<AppBindings>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: { code: "validation_error", message: result.error.issues[0]?.message ?? "Confira os campos." } }, 422);
      }
    },
  });
  app.onError((err, c) => {
    if (err instanceof ChannelsHttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    return onError(err, c);
  });

  // --- Rotas autenticadas (sessão + channel.manage) -------------------------------------------------------
  // IMPORTANTE: o middleware cobre só /channels e /channels/*. As rotas /webhooks/* abaixo são públicas de propósito.
  app.use("/channels", requireAuth(deps));
  app.use("/channels/*", requireAuth(deps));

  /** Autoriza: papel com `channel.manage`. Devolve o contexto da empresa ou lança 403. */
  async function authorize(c: Context<AppBindings>): Promise<service.Ctx> {
    const result = await buildSession(deps.db, c.get("authSession"));
    if (result.ok) {
      const blocked = accessGate(result.session, c.req.path);
      if (blocked) throw new ChannelsHttpError(blocked.status, blocked.body.error.code, blocked.body.error.message);
    }
    if (!result.ok) throw new ChannelsHttpError(403, result.code, "Termine o cadastro da sua empresa para continuar.");
    if (!can(result.session.user.role, "channel.manage")) {
      throw new ChannelsHttpError(403, "forbidden", "Você não tem permissão para gerenciar canais.");
    }
    return { organizationId: result.session.organization.id };
  }

  /** Corrida entre duas criações com o mesmo nome cai no índice único: vira 409, não 500. */
  async function guardDuplicate<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ChannelsHttpError(409, "duplicate_name", "Já existe um canal com esse nome.");
      throw error;
    }
  }

  app.openapi(plainRoute("get", "/channels", "Canais, vínculos e limite do plano", channelsOverviewSchema), async (c) => {
    return c.json(await service.getOverview(deps.db, await authorize(c), rt), 200);
  });

  app.openapi(bodyRoute("post", "/channels", "Cria um canal (limite e tipo conforme o plano)", createChannelInputSchema, channelSchema), async (c) => {
    const ctx = await authorize(c);
    const input = c.req.valid("json");
    return c.json(unwrap(await guardDuplicate(() => service.createChannel(deps.db, ctx, input))), 200);
  });

  app.openapi(bodyRoute("post", "/channels/assign-team", "Define os canais de uma equipe", assignTeamChannelsInputSchema, okSchema), async (c) => {
    const ctx = await authorize(c);
    const input = c.req.valid("json");
    unwrap(await service.assignTeamChannels(deps.db, ctx, input.teamId, input.channelIds));
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(idRoute("post", "/channels/{id}/qr", "Gera ou renova o QR Code", qrSessionSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.startQrSession(deps.db, ctx, rt, c.req.valid("param").id)), 200);
  });

  app.openapi(idRoute("get", "/channels/{id}/qr", "Consulta o QR Code atual (polling)", qrSessionSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.getQrSession(deps.db, ctx, rt, c.req.valid("param").id)), 200);
  });

  app.openapi(idRoute("get", "/channels/{id}/official-webhook", "URL e token de verificação do webhook (API oficial)", officialWebhookInfoSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.getOfficialWebhookInfo(deps.db, ctx, rt, c.req.valid("param").id)), 200);
  });

  app.openapi(idBodyRoute("post", "/channels/{id}/official-credentials", "Conecta a API oficial (valida o token na Meta)", officialCredentialsInputSchema, channelSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.connectOfficialChannel(deps.db, ctx, rt, c.req.valid("param").id, c.req.valid("json"))), 200);
  });

  app.openapi(idRoute("post", "/channels/{id}/instagram/authorize", "Autoriza o Instagram (SIMULADO nesta fase)", channelSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.authorizeInstagram(deps.db, ctx, c.req.valid("param").id)), 200);
  });

  app.openapi(idRoute("post", "/channels/{id}/disconnect", "Desconecta o canal", channelSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.disconnectChannel(deps.db, ctx, rt, c.req.valid("param").id)), 200);
  });

  app.openapi(idRoute("post", "/channels/{id}/default", "Define o canal padrão", okSchema), async (c) => {
    const ctx = await authorize(c);
    unwrap(await service.setDefaultChannel(deps.db, ctx, c.req.valid("param").id));
    return c.json({ ok: true as const }, 200);
  });

  app.openapi(idRoute("post", "/channels/{id}/rotate-webhook-token", "Gira o token secreto da URL do webhook", rotateWebhookTokenResultSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.rotateWebhookToken(deps.db, ctx, rt, c.req.valid("param").id)), 200);
  });

  app.openapi(idBodyRoute("patch", "/channels/{id}", "Atualiza vínculos, mensagens e transferência por inatividade", updateChannelSettingsInputSchema, channelSchema), async (c) => {
    const ctx = await authorize(c);
    return c.json(unwrap(await service.updateChannelSettings(deps.db, ctx, rt, c.req.valid("param").id, c.req.valid("json"))), 200);
  });

  const deletedSchema = z.object({ ok: z.literal(true), preservedConversations: z.number().int() });
  app.openapi(idRoute("delete", "/channels/{id}", "Exclui o canal (conversas e mensagens ficam salvas)", deletedSchema), async (c) => {
    const ctx = await authorize(c);
    const result = unwrap(await service.deleteChannel(deps.db, ctx, rt, c.req.valid("param").id));
    return c.json({ ok: true as const, preservedConversations: result.preservedConversations }, 200);
  });

  // --- Webhooks de entrada: PÚBLICOS (sem sessão). Autenticidade = token secreto na URL + verificação do provedor. ---
  // Fora do OpenAPI de propósito (não fazem parte da API do produto).
  const ports = databasePorts(deps.db, rt);
  const serve = async (c: Context<AppBindings>) => {
    const outcome = await handleWebhook({ ports, rt }, c.req.raw, { provider: c.req.param("provider") ?? "", token: c.req.param("token") ?? "" });
    if ("text" in outcome) return c.text(outcome.text, 200);
    return c.json(outcome.body, outcome.status);
  };
  app.get("/webhooks/wa/:provider/:token", serve);
  app.post("/webhooks/wa/:provider/:token", serve);

  return app;
}
