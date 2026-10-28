import {
  conversationModeSchema,
  conversationPrioritySchema,
  inboxTabSchema,
  messageAttachmentSchema,
  scheduleAppointmentInputSchema,
  sendMessageInputSchema,
  suggestionRatingSchema,
  transferTargetSchema,
  type InboxFilters,
} from "@duckzap/contracts/conversations";
import { can } from "@duckzap/contracts/permissions";
import type { Transaction } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { withOrgRealtime } from "../../lib/realtime";
import { ApiError, idParam, jsonLimit, moduleErrorHandler, parseWith, permit, readJson, requestCtx, tenantGuard, unwrap, type ModuleContext } from "./http";
import { rateSuggestion, suggestReply } from "./ai-turn";
import { openBodySchema, openConversationForContact } from "./open";
import * as queries from "./queries";
import { activateConversations, createConversationsRuntime, type ConversationsRuntime, type RuntimeOverrides } from "./runtime";
import * as service from "./service";

/**
 * Rotas do inbox (todas sob /v1). Fina: autenticar → autorizar (matriz `can`) → validar (Zod) → service → serializar.
 * Visibilidade: quem não tem `conversation.view_all` só alcança o que é seu, a fila e as conversas sem responsável das suas
 * equipes; qualquer outra conversa (ou de outra empresa) responde 404, igual a "não existe".
 *
 *   GET    /inbox/lookups                                   catálogos do inbox                      sessão
 *   GET    /conversations?tab&channelId&teamId&tagId&priority&search   lista + contagens por aba      sessão (+ visibilidade)
 *   GET    /conversations/:id                               detalhe                                  sessão (+ visibilidade)
 *   GET    /inbox/access/{conversation|contact|task}/:id    200/404: a pessoa alcança este item?     sessão
 *   POST   /conversations/:id/read                          marca como lida                          conversation.reply
 *   POST   /conversations/:id/assume                        assume                                   conversation.assign
 *   POST   /conversations/:id/transfer                      pessoa ou equipe (+ nota)                conversation.transfer
 *   POST   /conversations/:id/mode                          IA / Copiloto / Só humano                conversation.assign
 *   POST   /conversations/:id/resolve | /reopen             resolve / reabre                         conversation.reply
 *   POST   /conversations/:id/stage                         etapa do funil                           contact.edit
 *   POST   /conversations/:id/messages                      envia texto/mídia ou nota interna        conversation.reply (envio: plano ativo)
 *   POST   /conversations/:id/messages/:messageId/resend    reenvia mensagem que falhou              conversation.reply (plano ativo)
 *   POST   /conversations/:id/suggestions                   "sugerir resposta" (IA)                  conversation.reply
 *   POST   /inbox/suggestions/:id/rating                    útil/ruim                                conversation.reply
 *   POST   /conversations/:id/follow-up                     agenda follow-up                         conversation.reply
 *   PATCH  /conversations/:id/follow-up                     pausa/retoma                             conversation.reply
 *   DELETE /conversations/:id/follow-up                     cancela                                  conversation.reply
 *   POST   /conversations/:id/appointments                  agenda pelo painel (checa conflito)      appointment.manage
 *   POST   /inbox/contacts/:contactId/tags                  etiquetas do cliente (sem etapas)        contact.edit
 *   PATCH  /inbox/contacts/:contactId/notes                 nota do painel                           contact.edit
 *   POST   /inbox/contacts/:contactId/tasks                 tarefa do cliente                        contact.edit
 *   PATCH  /inbox/tasks/:taskId                             conclui/reabre tarefa do cliente         contact.edit
 *   POST   /quick-replies · DELETE /quick-replies/:id       respostas rápidas                        settings.manage
 */

const listQuerySchema = z.object({
  tab: inboxTabSchema.default("mine"),
  channelId: z.string().max(64).optional(),
  teamId: z.string().max(64).optional(),
  tagId: z.string().max(64).optional(),
  priority: conversationPrioritySchema.optional(),
  search: z.string().trim().max(100).optional(),
});

const transferBodySchema = z.object({ target: transferTargetSchema, note: z.string().trim().max(1000).nullable().default(null) });
// o contrato não limita os campos do anexo; o servidor limita. No envio só `mediaId` vale: nome, tipo, tamanho e `url` vindos
// do cliente são ignorados (o arquivo é o upload conferido, ver modules/media)
const attachmentSchema = messageAttachmentSchema.extend({
  fileName: z.string().max(255).nullable(),
  mimeType: z.string().max(100),
  url: z.string().max(2048).nullable(),
  mediaId: z.string().max(64).nullable().optional(),
});
const sendBodySchema = sendMessageInputSchema.omit({ conversationId: true }).extend({ body: z.string().max(4096), attachment: attachmentSchema.nullable() });
const appointmentBodySchema = scheduleAppointmentInputSchema.omit({ conversationId: true });
const stageBodySchema = z.object({ stageId: z.string().min(1).max(64) });
const modeBodySchema = z.object({ mode: conversationModeSchema });
const tagsBodySchema = z.object({ tagIds: z.array(z.string().min(1).max(64)).max(20) });
const notesBodySchema = z.object({ notes: z.string().trim().max(2000) });
const taskBodySchema = z.object({ title: z.string().trim().min(1, "Escreva a tarefa.").max(200), dueAt: z.iso.datetime().nullable().default(null) });
const doneBodySchema = z.object({ done: z.boolean() });
const followUpBodySchema = z.object({ scheduledAt: z.iso.datetime() });
const pausedBodySchema = z.object({ paused: z.boolean() });
const ratingBodySchema = z.object({ rating: suggestionRatingSchema });
const quickReplyBodySchema = z.object({
  shortcut: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]+$/, "Use só letras, números, - e _ no atalho.").max(30),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(1000),
});

export function conversationsRoutes(deps: Deps, overrides: RuntimeOverrides = {}) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);

  const runtime: ConversationsRuntime = createConversationsRuntime(deps, overrides);
  // o handler de mensagens recebidas (§3.3) se registra uma vez por processo; `false` só em testes isolados
  if (overrides.register !== false) activateConversations(runtime);

  const convCtx = (c: ModuleContext): queries.ConvCtx => {
    const ctx = requestCtx(c);
    return {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      userName: ctx.userName,
      timeZone: ctx.timeZone,
      orgName: ctx.orgName,
      canViewAll: can(ctx.role, "conversation.view_all"),
      sendingPaused: ctx.sendingPaused,
    };
  };
  const run = <T>(c: ModuleContext, fn: (tx: Transaction, ctx: queries.ConvCtx) => Promise<T>) => {
    const ctx = convCtx(c);
    return withOrgRealtime(deps.db, ctx.organizationId, (tx) => fn(tx, ctx));
  };

  // ── leitura ────────────────────────────────────────────────────────────────
  app.get("/inbox/lookups", guard, async (c) => c.json(await run(c, (tx, ctx) => queries.getInboxLookups(tx, ctx))));

  app.get("/conversations", guard, async (c) => {
    const q = parseWith(listQuerySchema, c.req.query());
    const filters: InboxFilters = {
      tab: q.tab,
      channelId: q.channelId || null,
      teamId: q.teamId || null,
      tagId: q.tagId || null,
      priority: q.priority ?? null,
      search: q.search || null,
    };
    return c.json(await run(c, (tx, ctx) => queries.listConversations(tx, ctx, filters)));
  });

  app.get("/conversations/:id", guard, async (c) => {
    const id = idParam(c);
    const detail = await run(c, (tx, ctx) => queries.getConversationDetail(tx, ctx, id));
    if (!detail) throw new ApiError(404, "not_found", "Conversa não encontrada.");
    return c.json(detail);
  });

  // checagens de acesso usadas pelas Server Actions antes de mutar (200 = alcança, 404 = não)
  app.get("/inbox/access/conversation/:id", guard, async (c) => {
    const id = idParam(c);
    const row = await run(c, (tx, ctx) => queries.findVisibleConversation(tx, ctx, id));
    if (!row) throw new ApiError(404, "not_found", "Conversa não encontrada.");
    return c.json({ ok: true });
  });
  app.get("/inbox/access/contact/:id", guard, async (c) => {
    const id = idParam(c);
    if (!(await run(c, (tx, ctx) => queries.canAccessContact(tx, ctx, id)))) throw new ApiError(404, "not_found", "Cliente não encontrado.");
    return c.json({ ok: true });
  });
  app.get("/inbox/access/task/:id", guard, async (c) => {
    const id = idParam(c);
    if (!(await run(c, (tx, ctx) => queries.canAccessTask(tx, ctx, id)))) throw new ApiError(404, "not_found", "Tarefa não encontrada.");
    return c.json({ ok: true });
  });

  // abre (ou cria/reabre) a conversa com um cliente a partir da ficha ou da agenda
  app.post("/conversations/open", guard, permit("conversation.reply"), jsonLimit, async (c) => {
    const body = await readJson(c, openBodySchema);
    const opened = unwrap(await run(c, (tx, ctx) => openConversationForContact(tx, ctx.organizationId, ctx, body.contactId, { reopenWindowDays: runtime.config.CONVERSATIONS_REOPEN_WINDOW_DAYS })));
    return c.json({ conversationId: opened.conversationId });
  });

  // ── ações sobre a conversa ─────────────────────────────────────────────────
  app.post("/conversations/:id/read", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    unwrap(await run(c, (tx, ctx) => service.markConversationRead(tx, ctx, id)));
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/assume", guard, permit("conversation.assign"), async (c) => {
    const id = idParam(c);
    unwrap(await run(c, (tx, ctx) => service.assumeConversation(tx, ctx, id)));
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/transfer", guard, permit("conversation.transfer"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, transferBodySchema);
    unwrap(await run(c, (tx, ctx) => service.transferConversation(tx, ctx, id, body.target, body.note || null)));
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/mode", guard, permit("conversation.assign"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, modeBodySchema);
    unwrap(await run(c, (tx, ctx) => service.setConversationMode(tx, ctx, id, body.mode)));
    return c.json({ ok: true });
  });

  // resolver/reabrir e funil não têm permissão própria na matriz: usam a mais próxima, como o front (conversation.reply / contact.edit)
  app.post("/conversations/:id/resolve", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    unwrap(await run(c, (tx, ctx) => service.resolveConversation(tx, ctx, id)));
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/reopen", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    unwrap(await run(c, (tx, ctx) => service.reopenConversation(tx, ctx, id)));
    return c.json({ ok: true });
  });

  app.post("/conversations/:id/stage", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, stageBodySchema);
    unwrap(await run(c, (tx, ctx) => service.moveConversationStage(tx, ctx, id, body.stageId)));
    return c.json({ ok: true });
  });

  // ── mensagens ──────────────────────────────────────────────────────────────
  app.post("/conversations/:id/messages", guard, permit("conversation.reply"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, sendBodySchema);
    if ((body.kind === "text" || body.kind === "note") && !body.body.trim()) {
      throw new ApiError(422, "validation_error", body.kind === "note" ? "Escreva a nota antes de salvar." : "Escreva a mensagem antes de enviar.");
    }
    const sent = unwrap(await run(c, (tx, ctx) => service.sendMessage(tx, ctx, { ...body, body: body.body.trim(), conversationId: id })));
    // `reconnect`: dica para a tela oferecer "Reconectar" quando o canal está fora do ar (fora do contrato da mensagem)
    return c.json({ ...sent.message, ...(sent.reconnect ? { reconnect: true } : {}) }, 201);
  });

  app.post("/conversations/:id/messages/:messageId/resend", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    const messageId = idParam(c, "messageId");
    return c.json(unwrap(await run(c, (tx, ctx) => service.resendMessage(tx, ctx, id, messageId))));
  });

  // ── copiloto ───────────────────────────────────────────────────────────────
  app.post("/conversations/:id/suggestions", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    return c.json(unwrap(await run(c, (tx, ctx) => suggestReply(tx, runtime.ai, runtime.limiters, ctx, id))));
  });

  app.post("/inbox/suggestions/:id/rating", guard, permit("conversation.reply"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, ratingBodySchema);
    unwrap(await run(c, (tx, ctx) => rateSuggestion(tx, ctx, id, body.rating)));
    return c.json({ ok: true });
  });

  // ── follow-up ──────────────────────────────────────────────────────────────
  app.post("/conversations/:id/follow-up", guard, permit("conversation.reply"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, followUpBodySchema);
    unwrap(await run(c, (tx, ctx) => service.scheduleFollowUp(tx, ctx, id, body.scheduledAt)));
    return c.json({ ok: true });
  });

  app.patch("/conversations/:id/follow-up", guard, permit("conversation.reply"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, pausedBodySchema);
    unwrap(await run(c, (tx, ctx) => service.setFollowUpPaused(tx, ctx, id, body.paused)));
    return c.json({ ok: true });
  });

  app.delete("/conversations/:id/follow-up", guard, permit("conversation.reply"), async (c) => {
    const id = idParam(c);
    unwrap(await run(c, (tx, ctx) => service.cancelFollowUp(tx, ctx, id)));
    return c.json({ ok: true });
  });

  // ── cliente ────────────────────────────────────────────────────────────────
  app.post("/conversations/:id/appointments", guard, permit("appointment.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const body = await readJson(c, appointmentBodySchema);
    if (new Date(body.startsAt).getTime() < Date.now()) throw new ApiError(422, "in_past", "Escolha um horário no futuro.");
    const created = unwrap(await run(c, (tx, ctx) => service.scheduleAppointment(tx, ctx, { ...body, conversationId: id })));
    return c.json(created, 201);
  });

  app.post("/inbox/contacts/:contactId/tags", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const contactId = idParam(c, "contactId");
    const body = await readJson(c, tagsBodySchema);
    unwrap(await run(c, (tx, ctx) => service.setContactTags(tx, ctx, contactId, body.tagIds)));
    return c.json({ ok: true });
  });

  app.patch("/inbox/contacts/:contactId/notes", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const contactId = idParam(c, "contactId");
    const body = await readJson(c, notesBodySchema);
    unwrap(await run(c, (tx, ctx) => service.updateContactNotes(tx, ctx, contactId, body.notes)));
    return c.json({ ok: true });
  });

  app.post("/inbox/contacts/:contactId/tasks", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const contactId = idParam(c, "contactId");
    const body = await readJson(c, taskBodySchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.createContactTask(tx, ctx, contactId, body))), 201);
  });

  app.patch("/inbox/tasks/:taskId", guard, permit("contact.edit"), jsonLimit, async (c) => {
    const taskId = idParam(c, "taskId");
    const body = await readJson(c, doneBodySchema);
    unwrap(await run(c, (tx, ctx) => service.setContactTaskDone(tx, ctx, taskId, body.done)));
    return c.json({ ok: true });
  });

  // ── respostas rápidas ──────────────────────────────────────────────────────
  app.post("/quick-replies", guard, permit("settings.manage"), jsonLimit, async (c) => {
    const body = await readJson(c, quickReplyBodySchema);
    return c.json(unwrap(await run(c, (tx, ctx) => service.createQuickReply(tx, ctx, body))), 201);
  });

  app.delete("/quick-replies/:id", guard, permit("settings.manage"), async (c) => {
    const id = idParam(c);
    unwrap(await run(c, (tx, ctx) => service.deleteQuickReply(tx, ctx, id)));
    return c.json({ ok: true });
  });

  return app;
}

export type { ConversationsRuntime };
