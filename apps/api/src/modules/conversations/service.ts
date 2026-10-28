import type {
  ContactAppointment,
  ContactTask,
  ConversationMode,
  Message,
  ScheduleAppointmentInput,
  SendMessageInput,
  TransferTarget,
} from "@duckzap/contracts/conversations";
import type { RealtimeEvent } from "@duckzap/contracts/realtime";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { queueRealtime } from "../../lib/realtime";
import { findSendChannel } from "../channels/repo";
import { isGuid } from "../contacts/http";
import { fail, newId, ok, type Result } from "../contacts/result";
import { recordContactEvent } from "../contacts/service";
import { createAppointment } from "../appointments/service";
import { zonedDay, zonedTime } from "../appointments/time";
import { checkCopilotAllowed } from "../agents/plan";
import { addEvent, addNote, auditState, deliverOutbound, type Media } from "./outbound";
import { findVisibleConversation, loadTags, mediaSchema, toMessage, canAccessContact, type ConvCtx } from "./queries";

const { conversations, messages, contacts, contactTags, tags, member, memberProfiles, teams, teamMembers, user } = schema;

// Casos de uso do inbox. Cada função recebe a transação já aberta com o tenant fixado (`withOrg`) e o contexto da sessão.
// Conversa de outra empresa, id malformado ou conversa que a pessoa não pode ver = "not_found" (404), sem revelar existência.

type NotFound = "not_found";
const NOT_FOUND = () => fail("not_found" as const, "Conversa não encontrada.");

function fmtDateTime(at: Date, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(at);
}

const MODE_LABEL: Record<ConversationMode, string> = { ai: "IA responde", copilot: "Copiloto", human: "Só humano" };

type UpdateReason = Extract<RealtimeEvent, { type: "conversation.updated" }>["reason"];

/** Aviso (só ids, publicado depois do commit) de que a conversa mudou; `home` quando a fila/os números do Início podem ter mudado. */
function notifyUpdated(tx: Transaction, organizationId: string, conversationId: string, reason: UpdateReason, home = false) {
  queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId, reason });
  if (home) queueRealtime(tx, organizationId, { type: "home.invalidate" });
}

// ── ações sobre a conversa ──────────────────────────────────────────────────

export async function markConversationRead(tx: Transaction, ctx: ConvCtx, id: string): Promise<Result<null, NotFound>> {
  const conv = await findVisibleConversation(tx, ctx, id);
  if (!conv) return NOT_FOUND();
  if (conv.unreadCount !== 0) {
    await tx.update(conversations).set({ unreadCount: 0 }).where(eq(conversations.id, conv.id));
    notifyUpdated(tx, ctx.organizationId, conv.id, "read");
  }
  return ok(null);
}

/** "Assumir": a pessoa vira responsável e a IA deixa de responder sozinha. */
export async function assumeConversation(tx: Transaction, ctx: ConvCtx, id: string, now = new Date()): Promise<Result<null, NotFound | "resolved">> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  if (conv.status === "resolved") return fail("resolved", "Reabra a conversa antes de assumir.");
  await tx
    .update(conversations)
    .set({
      assigneeId: ctx.userId,
      status: "human_active",
      waitingSince: null,
      aiDueAt: null,
      // a IA sai de cena: vira Copiloto se a empresa tem o recurso ligado; senão, Só humano
      mode: conv.mode === "ai" ? ((await copilotAvailable(tx, ctx)) ? "copilot" : "human") : conv.mode,
      updatedAt: now,
    })
    .where(eq(conversations.id, conv.id));
  await addEvent(tx, conv, `${ctx.userName} assumiu a conversa`, now);
  await auditState(tx, conv, { from: conv.status, to: "human_active", event: "human_took_over", actor: "human", userId: ctx.userId });
  notifyUpdated(tx, ctx.organizationId, conv.id, "assigned", conv.waitingSince !== null || conv.status === "handoff_requested");
  return ok(null);
}

async function activeMemberTeams(tx: Transaction, organizationId: string, userId: string): Promise<{ ok: boolean; name: string; teamIds: string[] }> {
  const [row] = await tx
    .select({ name: user.name, active: memberProfiles.active })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(memberProfiles, and(eq(memberProfiles.userId, member.userId), eq(memberProfiles.organizationId, organizationId)))
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  if (!row || row.active === false) return { ok: false, name: "", teamIds: [] };
  const links = await tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.organizationId, organizationId), eq(teamMembers.memberRef, userId)));
  return { ok: true, name: row.name, teamIds: links.map((l) => l.teamId) };
}

export async function transferConversation(
  tx: Transaction,
  ctx: ConvCtx,
  id: string,
  target: TransferTarget,
  note: string | null,
  now = new Date(),
): Promise<Result<null, NotFound | "invalid_target">> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();

  if (target.kind === "member") {
    const person = await activeMemberTeams(tx, ctx.organizationId, target.memberId);
    if (!person.ok) return fail("invalid_target", "Escolha uma pessoa da equipe.");
    const keepTeam = conv.teamId !== null && person.teamIds.includes(conv.teamId);
    await tx
      .update(conversations)
      .set({
        assigneeId: target.memberId,
        status: "human_active",
        waitingSince: null,
        aiDueAt: null,
        teamId: keepTeam ? conv.teamId : (person.teamIds[0] ?? conv.teamId),
        updatedAt: now,
      })
      .where(eq(conversations.id, conv.id));
    await addEvent(tx, conv, `${ctx.userName} transferiu para ${person.name}`, now);
    await auditState(tx, conv, { from: conv.status, to: "human_active", event: "human_took_over", actor: "human", reason: "transferência", userId: ctx.userId });
  } else {
    if (!isGuid(target.teamId)) return fail("invalid_target", "Escolha uma equipe.");
    const [team] = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(eq(teams.organizationId, ctx.organizationId), eq(teams.id, target.teamId)))
      .limit(1);
    if (!team) return fail("invalid_target", "Escolha uma equipe.");
    await tx
      .update(conversations)
      .set({ teamId: team.id, assigneeId: null, status: "handoff_requested", waitingSince: now, aiDueAt: null, updatedAt: now })
      .where(eq(conversations.id, conv.id));
    await addEvent(tx, conv, `${ctx.userName} transferiu para a equipe ${team.name} · conversa na fila de espera`, now);
    await auditState(tx, conv, { from: conv.status, to: "handoff_requested", event: "handoff_requested", actor: "human", reason: "transferência para equipe", userId: ctx.userId });
  }
  if (note) await addNote(tx, conv, { kind: "member", id: ctx.userId, name: ctx.userName }, note, null, now);
  notifyUpdated(tx, ctx.organizationId, conv.id, "transferred", true);
  return ok(null);
}

async function planFeatures(tx: Transaction, ctx: ConvCtx): Promise<readonly string[]> {
  const [row] = await tx
    .select({ features: schema.plans.features })
    .from(schema.subscriptions)
    .innerJoin(schema.plans, eq(schema.plans.slug, schema.subscriptions.planSlug))
    .where(eq(schema.subscriptions.organizationId, ctx.organizationId))
    .limit(1);
  return row?.features ?? [];
}

/** Copiloto exige o recurso no plano (Escala) E estar ligado em Agentes. */
async function copilotAvailable(tx: Transaction, ctx: ConvCtx): Promise<boolean> {
  const allowed = checkCopilotAllowed({ maxAgents: null, features: await planFeatures(tx, ctx) });
  if (!allowed.ok) return false;
  const [settings] = await tx.select({ enabled: schema.copilotSettings.enabled }).from(schema.copilotSettings).where(eq(schema.copilotSettings.organizationId, ctx.organizationId)).limit(1);
  return settings?.enabled === true;
}

export async function setConversationMode(
  tx: Transaction,
  ctx: ConvCtx,
  id: string,
  mode: ConversationMode,
  now = new Date(),
): Promise<Result<null, NotFound | "plan_feature">> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  if (conv.mode === mode) return ok(null);

  if (mode === "copilot") {
    // Copiloto: recurso do plano Escala (aplicado aqui, não só na tela) e precisa estar ligado em Agentes
    const allowed = checkCopilotAllowed({ maxAgents: null, features: await planFeatures(tx, ctx) });
    if (!allowed.ok) return fail("plan_feature", allowed.message);
    if (!(await copilotAvailable(tx, ctx))) return fail("plan_feature", "Ligue o Copiloto em Agentes para usar este modo.");
  }

  const patch: Partial<typeof conversations.$inferInsert> = { mode, updatedAt: now };
  let to = conv.status;
  if (mode === "ai" && (conv.status === "human_active" || conv.status === "handoff_requested")) {
    // devolver para a IA = a pessoa sai e a fila esvazia
    patch.status = "ai_active";
    patch.assigneeId = null;
    patch.waitingSince = null;
    to = "ai_active";
  }
  if (mode !== "ai") patch.aiDueAt = null;
  await tx.update(conversations).set(patch).where(eq(conversations.id, conv.id));
  await addEvent(tx, conv, `${ctx.userName} mudou o modo para ${MODE_LABEL[mode]}`, now);
  if (to !== conv.status) await auditState(tx, conv, { from: conv.status, to, event: "ai_resumed", actor: "human", userId: ctx.userId });
  notifyUpdated(tx, ctx.organizationId, conv.id, "mode", to !== conv.status);
  return ok(null);
}

export async function resolveConversation(tx: Transaction, ctx: ConvCtx, id: string, now = new Date()): Promise<Result<null, NotFound>> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  if (conv.status === "resolved") return ok(null);
  await tx
    .update(conversations)
    .set({
      status: "resolved",
      resolvedBy: "human",
      resolvedAt: now,
      assigneeId: conv.assigneeId ?? ctx.userId,
      waitingSince: null,
      unreadCount: 0,
      aiDueAt: null,
      followUpPaused: conv.followUpAt ? true : conv.followUpPaused,
      updatedAt: now,
    })
    .where(eq(conversations.id, conv.id));
  await addEvent(tx, conv, `${ctx.userName} resolveu a conversa`, now);
  await auditState(tx, conv, { from: conv.status, to: "resolved", event: "resolved", actor: "human", userId: ctx.userId });
  notifyUpdated(tx, ctx.organizationId, conv.id, "resolved", true);
  return ok(null);
}

export async function reopenConversation(tx: Transaction, ctx: ConvCtx, id: string, now = new Date()): Promise<Result<null, NotFound | "conflict">> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  if (conv.status !== "resolved") return ok(null);
  // só pode haver uma conversa aberta por contato+canal: se o cliente já abriu outra, reabrir esta duplicaria
  const [open] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.contactId, conv.contactId), conv.channelId ? eq(conversations.channelId, conv.channelId) : isNull(conversations.channelId), sql`${conversations.status} <> 'resolved'`))
    .limit(1);
  if (open) return fail("conflict", "Este cliente já tem outra conversa aberta neste canal. Continue por ela.");
  await tx
    .update(conversations)
    .set({ status: "human_active", resolvedBy: null, resolvedAt: null, assigneeId: ctx.userId, waitingSince: null, updatedAt: now })
    .where(eq(conversations.id, conv.id));
  await addEvent(tx, conv, `${ctx.userName} reabriu a conversa`, now);
  await auditState(tx, conv, { from: "resolved", to: "human_active", event: "customer_message", actor: "human", reason: "reaberta pela equipe", userId: ctx.userId });
  notifyUpdated(tx, ctx.organizationId, conv.id, "reopened", true);
  return ok(null);
}

// ── etapa do funil e etiquetas (são etiquetas do contato) ───────────────────

export async function moveConversationStage(tx: Transaction, ctx: ConvCtx, id: string, stageId: string): Promise<Result<null, NotFound | "invalid_stage">> {
  const conv = await findVisibleConversation(tx, ctx, id);
  if (!conv) return NOT_FOUND();
  const all = await loadTags(tx, ctx);
  const stage = all.find((t) => t.id === stageId && t.funnelStage !== null);
  if (!stage) return fail("invalid_stage", "Etapa inválida.");
  await setFunnelStage(tx, ctx.organizationId, conv.contactId, stage.id, stage.name);
  notifyUpdated(tx, ctx.organizationId, conv.id, "stage");
  return ok(null);
}

/** Troca a etapa do contato: uma só etiqueta-etapa por vez. */
export async function setFunnelStage(tx: Transaction, organizationId: string, contactId: string, stageTagId: string, stageName: string) {
  const stageTags = tx.select({ id: tags.id }).from(tags).where(and(eq(tags.organizationId, organizationId), isNotNull(tags.funnelStage)));
  await tx.delete(contactTags).where(and(eq(contactTags.contactId, contactId), inArray(contactTags.tagId, stageTags)));
  const inserted = await tx.insert(contactTags).values({ organizationId, contactId, tagId: stageTagId }).onConflictDoNothing().returning({ t: contactTags.tagId });
  if (inserted.length) await recordContactEvent(tx, organizationId, contactId, "tag", `Etapa do funil: ${stageName}`);
}

/** Etiquetas do cliente, sem as etapas (que mudam por `moveConversationStage`). Troca o conjunto inteiro. */
export async function setContactTags(tx: Transaction, ctx: ConvCtx, contactId: string, tagIds: string[]): Promise<Result<null, "invalid_tag" | NotFound>> {
  if (!(await canAccessContact(tx, ctx, contactId))) return fail("not_found", "Cliente não encontrado.");
  const unique = [...new Set(tagIds)];
  if (unique.some((t) => !isGuid(t))) return fail("invalid_tag", "Etiqueta inválida.");
  const all = await loadTags(tx, ctx);
  const valid = new Set(all.filter((t) => t.funnelStage === null).map((t) => t.id));
  if (unique.some((t) => !valid.has(t))) return fail("invalid_tag", "Etiqueta inválida.");
  const plain = tx.select({ id: tags.id }).from(tags).where(and(eq(tags.organizationId, ctx.organizationId), sql`${tags.funnelStage} is null`));
  await tx.delete(contactTags).where(and(eq(contactTags.contactId, contactId), inArray(contactTags.tagId, plain)));
  if (unique.length) {
    await tx.insert(contactTags).values(unique.map((tagId) => ({ organizationId: ctx.organizationId, contactId, tagId }))).onConflictDoNothing();
  }
  return ok(null);
}

// ── mensagens ───────────────────────────────────────────────────────────────

export type SendOutcome = { message: Message; reconnect: boolean };

export async function sendMessage(
  tx: Transaction,
  ctx: ConvCtx,
  input: SendMessageInput,
  now = new Date(),
): Promise<Result<SendOutcome, NotFound | "resolved" | "sending_paused">> {
  const conv = await findVisibleConversation(tx, ctx, input.conversationId, { lock: true });
  if (!conv) return NOT_FOUND();
  const [contact] = await tx.select({ name: contacts.name, phone: contacts.phone, instagram: contacts.instagram }).from(contacts).where(eq(contacts.id, conv.contactId)).limit(1);
  if (!contact) return NOT_FOUND();
  const sender = { kind: "member" as const, id: ctx.userId, name: ctx.userName };

  if (input.kind === "note") {
    if (input.clientId) {
      const [dup] = await tx.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId))).limit(1);
      if (dup) return ok({ message: toMessage(dup, contact.name), reconnect: false });
    }
    const note = await addNote(tx, conv, sender, input.body, input.clientId || null, now);
    return ok({ message: toMessage(note, contact.name), reconnect: false });
  }

  // plano expirado: leitura liberada, envio barrado AQUI (a tela só reflete)
  if (ctx.sendingPaused) return fail("sending_paused", "Seu plano expirou. Você ainda vê as conversas, mas o envio fica pausado até renovar.");
  if (conv.status === "resolved") return fail("resolved", "Reabra a conversa para responder.");

  // responder assume o atendimento: sem responsável a pessoa vira o responsável e, se a IA ainda estava no comando (modo IA,
  // IA ativa ou transferência pendente), o modo passa a "Só humano" para a tela e a IA refletirem quem atende de verdade
  const aiStillInCharge = conv.mode === "ai" || conv.status === "ai_active" || conv.status === "handoff_requested";
  if (conv.assigneeId === null || aiStillInCharge) {
    await tx
      .update(conversations)
      .set({
        assigneeId: conv.assigneeId ?? ctx.userId,
        status: "human_active",
        waitingSince: null,
        aiDueAt: null,
        mode: conv.mode === "ai" ? "human" : conv.mode,
        updatedAt: now,
      })
      .where(eq(conversations.id, conv.id));
    await addEvent(tx, conv, `${ctx.userName} assumiu a conversa`, now);
    await auditState(tx, conv, { from: conv.status, to: "human_active", event: "human_took_over", actor: "human", reason: "respondeu", userId: ctx.userId });
    notifyUpdated(tx, ctx.organizationId, conv.id, "assigned", conv.waitingSince !== null || conv.status === "handoff_requested");
    conv.assigneeId = conv.assigneeId ?? ctx.userId;
    conv.status = "human_active";
    if (conv.mode === "ai") conv.mode = "human";
  }

  const channel = await findSendChannel(tx, ctx.organizationId, conv.channelId);
  const attachment: Media | null = input.attachment
    ? { fileName: input.attachment.fileName, mimeType: input.attachment.mimeType, sizeBytes: input.attachment.sizeBytes, durationSeconds: input.attachment.durationSeconds, url: input.attachment.url }
    : null;
  const delivered = await deliverOutbound(tx, {
    conv,
    channelName: channel?.name ?? "do cliente",
    to: contact.phone ?? contact.instagram,
    kind: input.kind,
    body: input.body,
    media: attachment,
    sender,
    externalId: `out:${newId()}`,
    clientId: input.clientId || null,
    countsAsReply: true,
    now,
  });
  return ok({ message: toMessage(delivered.message, contact.name), reconnect: delivered.reconnect });
}

export async function resendMessage(
  tx: Transaction,
  ctx: ConvCtx,
  conversationId: string,
  messageId: string,
  now = new Date(),
): Promise<Result<Message, NotFound | "not_failed" | "channel_down" | "send_failed" | "sending_paused">> {
  const conv = await findVisibleConversation(tx, ctx, conversationId, { lock: true });
  if (!conv || !isGuid(messageId)) return NOT_FOUND();
  const [row] = await tx.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.conversationId, conv.id))).limit(1);
  if (!row || row.direction !== "out") return fail("not_found", "Mensagem não encontrada.");
  if (row.status !== "failed") return fail("not_failed", "Esta mensagem já foi enviada.");
  if (ctx.sendingPaused) return fail("sending_paused", "Seu plano expirou. O envio fica pausado até renovar.");
  const [contact] = await tx.select({ name: contacts.name, phone: contacts.phone, instagram: contacts.instagram }).from(contacts).where(eq(contacts.id, conv.contactId)).limit(1);
  if (!contact) return NOT_FOUND();
  const channel = await findSendChannel(tx, ctx.organizationId, conv.channelId);
  const kind = row.kind === "audio" || row.kind === "image" || row.kind === "document" ? row.kind : "text";
  const parsedMedia = row.media ? mediaSchema.safeParse(row.media) : null;
  const media: Media | null = parsedMedia?.success ? parsedMedia.data : null;
  const result = await deliverOutbound(tx, {
    conv,
    channelName: channel?.name ?? "do cliente",
    to: contact.phone ?? contact.instagram,
    kind,
    body: row.body,
    media,
    // o remetente original: reenviar uma mensagem da IA não a transforma em mensagem de pessoa (assinada)
    sender:
      row.senderKind === "agent" || row.senderKind === "system"
        ? { kind: row.senderKind, id: row.senderId, name: row.senderName ?? "" }
        : { kind: "member", id: row.senderId ?? ctx.userId, name: row.senderName || ctx.userName },
    externalId: row.externalId ?? `out:${row.id}`,
    countsAsReply: true,
    existing: row,
    now,
  });
  if (result.ok) return ok(toMessage(result.message, contact.name));
  return fail(result.reconnect ? "channel_down" : "send_failed", result.reason ?? "Não foi possível reenviar.");
}

// ── follow-up ───────────────────────────────────────────────────────────────

export async function scheduleFollowUp(tx: Transaction, ctx: ConvCtx, id: string, scheduledAt: string, now = new Date()): Promise<Result<null, NotFound | "in_past">> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime()) return fail("in_past", "Escolha um horário no futuro.");
  await tx.update(conversations).set({ followUpAt: at, followUpPaused: false, updatedAt: now }).where(eq(conversations.id, conv.id));
  await addEvent(tx, conv, `${ctx.userName} agendou um follow-up para ${fmtDateTime(at, ctx.timeZone)}`, now);
  notifyUpdated(tx, ctx.organizationId, conv.id, "follow_up");
  return ok(null);
}

export async function setFollowUpPaused(tx: Transaction, ctx: ConvCtx, id: string, paused: boolean): Promise<Result<null, NotFound | "no_follow_up">> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  if (!conv.followUpAt) return fail("no_follow_up", "Esta conversa não tem follow-up agendado.");
  await tx.update(conversations).set({ followUpPaused: paused, updatedAt: new Date() }).where(eq(conversations.id, conv.id));
  notifyUpdated(tx, ctx.organizationId, conv.id, "follow_up");
  return ok(null);
}

export async function cancelFollowUp(tx: Transaction, ctx: ConvCtx, id: string): Promise<Result<null, NotFound>> {
  const conv = await findVisibleConversation(tx, ctx, id, { lock: true });
  if (!conv) return NOT_FOUND();
  await tx.update(conversations).set({ followUpAt: null, followUpPaused: false, updatedAt: new Date() }).where(eq(conversations.id, conv.id));
  notifyUpdated(tx, ctx.organizationId, conv.id, "follow_up");
  return ok(null);
}

// ── cliente: agendamento, notas, tarefas ────────────────────────────────────

export async function scheduleAppointment(
  tx: Transaction,
  ctx: ConvCtx,
  input: ScheduleAppointmentInput,
  now = new Date(),
): Promise<Result<ContactAppointment, NotFound | "invalid_type" | "invalid_professional" | "conflict">> {
  const conv = await findVisibleConversation(tx, ctx, input.conversationId);
  if (!conv) return NOT_FOUND();
  if (!isGuid(input.appointmentTypeId)) return fail("invalid_type", "Escolha o tipo de atendimento.");
  const [type] = await tx
    .select()
    .from(schema.appointmentTypes)
    .where(and(eq(schema.appointmentTypes.organizationId, ctx.organizationId), eq(schema.appointmentTypes.id, input.appointmentTypeId), eq(schema.appointmentTypes.active, true)))
    .limit(1);
  if (!type) return fail("invalid_type", "Escolha o tipo de atendimento.");

  // a tela escolhe o profissional pelo nome; a Agenda trabalha com o id da pessoa
  const owners = await tx
    .select({ id: user.id, name: user.name, active: memberProfiles.active })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(memberProfiles, and(eq(memberProfiles.userId, member.userId), eq(memberProfiles.organizationId, ctx.organizationId)))
    .where(eq(member.organizationId, ctx.organizationId))
    .orderBy(asc(user.name), asc(user.id));
  const owner = owners.find((o) => o.active !== false && o.name === input.professional);
  if (!owner) return fail("invalid_professional", "Escolha um profissional da equipe.");

  const startsAt = new Date(input.startsAt);
  const created = await createAppointment(
    tx,
    ctx,
    {
      contactId: conv.contactId,
      typeId: type.id,
      ownerId: owner.id,
      date: zonedDay(startsAt.toISOString(), ctx.timeZone),
      time: zonedTime(startsAt.toISOString(), ctx.timeZone),
      durationMinutes: type.durationMinutes,
      notes: "",
      allowConflict: false,
    },
    { source: "manual" },
    now,
  );
  if (!created.ok) {
    if (created.error === "conflict") return fail("conflict", `${input.professional} já tem um atendimento nesse horário. Escolha outro.`);
    if (created.error === "not_found") return NOT_FOUND();
    return fail("invalid_type", created.message);
  }
  await addEvent(tx, conv, `${ctx.userName} agendou ${type.name.toLowerCase()} com ${input.professional}`, now);
  return ok({
    id: created.data.id,
    startsAt: created.data.startsAt,
    typeName: type.name,
    professional: owner.name,
    status: created.data.status,
  });
}

/**
 * O painel mostra UMA nota do cliente. Ela é guardada como nota da ficha (Clientes) marcada com `authorId = panel:<pessoa>`,
 * então aparece nas duas telas. Texto vazio apaga a nota do painel.
 */
export async function updateContactNotes(tx: Transaction, ctx: ConvCtx, contactId: string, notes: string): Promise<Result<null, NotFound>> {
  if (!(await canAccessContact(tx, ctx, contactId))) return fail("not_found", "Cliente não encontrado.");
  const panel = and(eq(schema.contactNotes.contactId, contactId), sql`${schema.contactNotes.authorId} like 'panel:%'`);
  const [existing] = await tx.select({ id: schema.contactNotes.id }).from(schema.contactNotes).where(panel).limit(1);
  if (!notes) {
    if (existing) await tx.delete(schema.contactNotes).where(panel);
    return ok(null);
  }
  if (existing) {
    await tx.update(schema.contactNotes).set({ text: notes, authorId: `panel:${ctx.userId}`, authorName: ctx.userName }).where(eq(schema.contactNotes.id, existing.id));
  } else {
    await tx
      .insert(schema.contactNotes)
      .values({ id: newId(), organizationId: ctx.organizationId, contactId, authorId: `panel:${ctx.userId}`, authorName: ctx.userName, text: notes });
  }
  return ok(null);
}

export async function createContactTask(tx: Transaction, ctx: ConvCtx, contactId: string, input: { title: string; dueAt: string | null }): Promise<Result<ContactTask, NotFound>> {
  if (!(await canAccessContact(tx, ctx, contactId))) return fail("not_found", "Cliente não encontrado.");
  const [row] = await tx
    .insert(schema.tasks)
    .values({
      id: newId(),
      organizationId: ctx.organizationId,
      title: input.title,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      assigneeId: ctx.userId,
      contactId,
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error("tarefa não gravada");
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok({ id: row.id, title: row.title, dueAt: row.dueAt ? row.dueAt.toISOString() : null, done: row.done });
}

export async function setContactTaskDone(tx: Transaction, ctx: ConvCtx, taskId: string, done: boolean, now = new Date()): Promise<Result<null, NotFound>> {
  if (!isGuid(taskId)) return fail("not_found", "Tarefa não encontrada.");
  const [task] = await tx
    .select({ id: schema.tasks.id, contactId: schema.tasks.contactId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.organizationId, ctx.organizationId), eq(schema.tasks.id, taskId)))
    .limit(1);
  if (!task?.contactId || !(await canAccessContact(tx, ctx, task.contactId))) return fail("not_found", "Tarefa não encontrada.");
  await tx.update(schema.tasks).set({ done, doneAt: done ? now : null }).where(eq(schema.tasks.id, task.id));
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok(null);
}

// ── respostas rápidas ───────────────────────────────────────────────────────

export async function createQuickReply(tx: Transaction, ctx: ConvCtx, input: { shortcut: string; title: string; body: string }): Promise<Result<{ id: string }, "duplicate">> {
  const inserted = await tx
    .insert(schema.quickReplies)
    .values({ id: newId(), organizationId: ctx.organizationId, ...input })
    .onConflictDoNothing()
    .returning({ id: schema.quickReplies.id });
  const row = inserted[0];
  return row ? ok(row) : fail("duplicate", "Já existe uma resposta rápida com esse atalho.");
}

export async function deleteQuickReply(tx: Transaction, ctx: ConvCtx, id: string): Promise<Result<null, "not_found">> {
  if (!isGuid(id)) return fail("not_found", "Resposta rápida não encontrada.");
  const deleted = await tx
    .delete(schema.quickReplies)
    .where(and(eq(schema.quickReplies.organizationId, ctx.organizationId), eq(schema.quickReplies.id, id)))
    .returning({ id: schema.quickReplies.id });
  return deleted.length ? ok(null) : fail("not_found", "Resposta rápida não encontrada.");
}

