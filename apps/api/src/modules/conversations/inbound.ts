import { businessHoursSchema, type BusinessHours } from "@duckzap/contracts/settings";
import { schema, type Database, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { isWithinBusinessHours } from "@duckzap/ai";
import type { InboundContext } from "../../lib/inbound";
import type { InboundEvent } from "../../lib/messaging";
import { queueRealtime, withOrgRealtime } from "../../lib/realtime";
import { applyReminderReply } from "../appointments/service";
import { interpretReminderReply } from "../appointments/logic";
import { isSendingPausedForOrg } from "../channels/sending";
import { findChannel, type ChannelRow } from "../channels/repo";
import { effectiveConsentStatus } from "../contacts/consent";
import type { InboundMediaPort, PreparedInboundMedia } from "../media/inbound";
import { linkToMessage } from "../media/service";
import { newId, type ServiceCtx } from "../contacts/result";
import { registerConsentReply, registerOptOut, touchContactInteraction, upsertContactByPhone, ensureDefaultTags } from "../contacts/service";
import { defaultBusinessHours } from "../settings/defaults";
import type { ConversationsConfig } from "./config";
import {
  classifyInbound,
  computeAiDue,
  decideAutoMessage,
  initialConversationMode,
  lastMessageKindOf,
  nextMessageStatus,
  previewOf,
  shouldRunAi,
  statusAfterInbound,
  toAiHours,
} from "./logic";
import { addEvent, auditState, deliverOutbound } from "./outbound";
import { firstStageTag, loadActiveAgent, loadTags, modeOf, statusOf, type ConversationRow } from "./queries";
import { setFunnelStage } from "./service";

const { conversations, messages, contacts, teams, agents, consents, appointments } = schema;

export type InboundDeps = {
  db: Database;
  config: ConversationsConfig;
  /** Agenda a resposta da IA depois da janela da rajada. Padrão: temporizador do processo; um worker/fila o substitui. */
  scheduleAiTurn(organizationId: string, conversationId: string, delayMs: number): void;
  /** Baixa e guarda a mídia recebida (imagem/áudio/documento) antes de gravar a mensagem. Sem isto a mídia entra "indisponível". */
  media?: InboundMediaPort;
  now(): Date;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
};

export const OPT_OUT_CONFIRMATION = "Pronto, você não vai mais receber mensagens de divulgação da nossa parte. Se precisar de algo, é só chamar por aqui.";
export const CONSENT_GRANTED_REPLY = "Obrigado! A partir de agora você pode receber nossas novidades e lembretes por aqui.";
export const CONSENT_DENIED_REPLY = "Tudo bem, não vamos mais enviar mensagens de divulgação. Se precisar de algo, é só chamar.";

export const REMINDER_CONFIRMED_REPLY = "Perfeito, seu horário está confirmado. Até lá!";
export const REMINDER_RESCHEDULE_REPLY = "Tudo bem! Nossa equipe vai entrar em contato para remarcar o seu horário.";
const MEDIA_MIME: Record<string, string> = { image: "image/*", audio: "audio/*", document: "application/octet-stream" };
const REOPEN_STATUS_NOTE = "Cliente voltou a escrever · conversa reaberta";

// ── eventos de status (entregue / lida / falhou) ────────────────────────────

export async function applyStatusEvent(deps: InboundDeps, context: InboundContext, event: Extract<InboundEvent, { type: "status" }>) {
  await withOrgRealtime(deps.db, context.organizationId, async (tx) => {
    // o evento traz o id que o PROVEDOR deu à mensagem; mensagens de campanha não estão aqui e são ignoradas
    const [row] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, context.channelId), eq(messages.providerMessageId, event.externalId)))
      .limit(1);
    if (!row || row.direction !== "out") return;
    const current = row.status === "sending" || row.status === "sent" || row.status === "delivered" || row.status === "read" || row.status === "failed" ? row.status : null;
    const next = nextMessageStatus(current, event.status);
    if (!next) return;
    const at = new Date(event.at);
    await tx
      .update(messages)
      .set({
        status: next,
        updatedAt: new Date(),
        ...(next === "delivered" ? { deliveredAt: at } : {}),
        ...(next === "read" ? { readAt: at, deliveredAt: row.deliveredAt ?? at } : {}),
        ...(next === "failed" ? { error: "O WhatsApp não conseguiu entregar esta mensagem.", errorCode: "provider_failed" } : {}),
        ...(next === "sent" ? { sentAt: row.sentAt ?? at } : {}),
      })
      .where(eq(messages.id, row.id));
    queueRealtime(tx, context.organizationId, { type: "message.status", conversationId: row.conversationId, messageId: row.id, status: next });
  });
}

// ── roteamento de conversa nova ─────────────────────────────────────────────

export async function routeNewConversation(tx: Transaction, organizationId: string, channel: ChannelRow) {
  const isUuid = (v: string | null): v is string => v !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

  // equipe: a do canal (`channels.team_id`, única fonte de verdade); senão a de menor número de prioridade da empresa
  let teamId: string | null = null;
  if (isUuid(channel.teamId)) {
    const [t] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.organizationId, organizationId), eq(teams.id, channel.teamId))).limit(1);
    if (t) teamId = t.id;
  }
  if (!teamId) {
    const [t] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.organizationId, organizationId)).orderBy(asc(teams.priority)).limit(1);
    if (t) teamId = t.id;
  }

  // agente ativo: o do canal (`channels.agent_id`, única fonte de verdade)
  const agent = await loadActiveAgent(tx, organizationId, channel.agentId);
  return { teamId, agent: agent ?? null };
}

// ── conversa: acha, reabre ou cria ──────────────────────────────────────────

type Resolved = { conv: ConversationRow; created: boolean; reopened: boolean };

async function findOrCreateConversation(tx: Transaction, deps: InboundDeps, organizationId: string, channel: ChannelRow, contactId: string, now: Date): Promise<Resolved> {
  const lockedOpen = () =>
    tx
      .select()
      .from(conversations)
      // conversa ABERTA do contato continua a mesma mesmo que a mensagem entre por outro canal (prefere a do próprio canal)
      .where(and(eq(conversations.organizationId, organizationId), eq(conversations.contactId, contactId), ne(conversations.status, "resolved")))
      .orderBy(desc(sql`(${conversations.channelId} = ${channel.id})`), desc(conversations.lastMessageAt))
      .limit(1)
      .for("update");

  const [open] = await lockedOpen();
  if (open) {
    if (open.channelId === null) {
      // conversa que ficou sem canal (o canal foi apagado): passa a usar o canal por onde a mensagem entrou
      const [adopted] = await tx.update(conversations).set({ channelId: channel.id, updatedAt: now }).where(eq(conversations.id, open.id)).returning();
      return { conv: adopted ?? open, created: false, reopened: false };
    }
    return { conv: open, created: false, reopened: false };
  }

  const windowMs = deps.config.CONVERSATIONS_REOPEN_WINDOW_DAYS * 86_400_000;
  const [recent] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.contactId, contactId),
        or(eq(conversations.channelId, channel.id), isNull(conversations.channelId)),
        eq(conversations.status, "resolved"),
        gte(conversations.resolvedAt, new Date(now.getTime() - windowMs)),
      ),
    )
    .orderBy(desc(conversations.resolvedAt))
    .limit(1)
    .for("update");
  if (recent && windowMs > 0) {
    // reabre: volta ao responsável anterior, se havia; senão entra no fluxo normal do modo
    const [reopened] = await tx
      .update(conversations)
      .set({ status: recent.assigneeId ? "human_active" : "ai_active", resolvedBy: null, resolvedAt: null, channelId: recent.channelId ?? channel.id, updatedAt: now })
      .where(and(eq(conversations.id, recent.id)))
      .returning();
    if (reopened) return { conv: reopened, created: false, reopened: true };
  }

  const routing = await routeNewConversation(tx, organizationId, channel);
  // canal em modo "auto" (sem IA): a conversa nova já nasce em modo humano e entra na fila da equipe
  const mode = initialConversationMode(channel.replyMode, routing.agent !== null);
  const initial = statusAfterInbound({ status: "ai_active", mode, assigneeId: null }, routing.agent !== null);
  const inserted = await tx
    .insert(conversations)
    .values({
      id: newId(),
      organizationId,
      contactId,
      channelId: channel.id,
      teamId: routing.teamId,
      agentId: routing.agent?.id ?? null,
      status: initial.status,
      mode,
      waitingSince: initial.queued ? now : null,
      createdAt: now,
      lastMessageAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { conv: inserted[0], created: true, reopened: false };
  // outra mensagem do mesmo cliente criou a conversa um instante antes: usa a dela
  const [raced] = await lockedOpen();
  if (!raced) throw new Error("conversa não encontrada nem criada");
  return { conv: raced, created: false, reopened: false };
}

// ── horário comercial ───────────────────────────────────────────────────────

export async function businessHoursFor(tx: Transaction, organizationId: string, teamId: string | null): Promise<{ hours: BusinessHours; timeZone: string }> {
  const [org] = await tx.select({ tz: schema.organization.timeZone }).from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const timeZone = org?.tz ?? "America/Sao_Paulo";
  if (teamId) {
    const [team] = await tx.select({ hours: teams.businessHours }).from(teams).where(eq(teams.id, teamId)).limit(1);
    const parsed = businessHoursSchema.safeParse(team?.hours);
    if (parsed.success) return { hours: parsed.data, timeZone };
  }
  const [settings] = await tx.select({ hours: schema.organizationSettings.businessHours }).from(schema.organizationSettings).where(eq(schema.organizationSettings.organizationId, organizationId)).limit(1);
  const parsed = businessHoursSchema.safeParse(settings?.hours);
  return { hours: parsed.success ? parsed.data : defaultBusinessHours(), timeZone };
}

// ── mensagem recebida ───────────────────────────────────────────────────────

export type MessageOutcome =
  | { kind: "ignored"; reason: "no_channel" | "duplicate" | "invalid_phone" | "unsupported_address" }
  | { kind: "stored"; conversationId: string; messageId: string; optOut: boolean; consent: "granted" | "denied" | null; aiScheduled: { delayMs: number } | null };

/**
 * Fluxo da mensagem recebida (§3.3). A ordem é uma regra: opt-out (SAIR/PARAR/CANCELAR) é tratado ANTES de conversa,
 * mensagens automáticas e IA. Tudo roda numa transação com o tenant fixado; só o agendamento da IA acontece depois dela.
 */
export async function handleMessage(deps: InboundDeps, context: InboundContext, event: Extract<InboundEvent, { type: "message" }>): Promise<MessageOutcome> {
  const { organizationId } = context;
  const now = deps.now();

  // mídia recebida: baixa/guarda ANTES da transação da mensagem (o download é lento e não pode segurar o lock da conversa).
  // Falha aqui nunca derruba a mensagem: ela entra com o texto/legenda e o anexo "indisponível".
  const prepared: PreparedInboundMedia = deps.media ? await deps.media.prepare(deps.db, context, event) : { state: "none" };
  const storedFile = prepared.state === "stored" ? prepared.file : null;

  let outcome: MessageOutcome;
  try {
    outcome = await storeMessage(deps, context, event, prepared, now);
  } catch (error) {
    if (storedFile) await deps.media?.discard(deps.db, organizationId, storedFile);
    throw error;
  }
  // a mensagem não foi gravada (repetida, contato inválido…): o arquivo recém-guardado não tem dono
  if (storedFile && outcome.kind !== "stored") await deps.media?.discard(deps.db, organizationId, storedFile);

  // depois do commit: o temporizador só dispara o que já está gravado (`ai_due_at` é a fonte da verdade; a varredura cobre quedas)
  if (outcome.kind === "stored" && outcome.aiScheduled) deps.scheduleAiTurn(organizationId, outcome.conversationId, outcome.aiScheduled.delayMs);
  return outcome;
}

async function storeMessage(deps: InboundDeps, context: InboundContext, event: Extract<InboundEvent, { type: "message" }>, prepared: PreparedInboundMedia, now: Date): Promise<MessageOutcome> {
  const { organizationId } = context;
  const outcome = await withOrgRealtime(deps.db, organizationId, async (tx): Promise<MessageOutcome> => {
    const channel = await findChannel(tx, organizationId, context.channelId);
    if (!channel) return { kind: "ignored", reason: "no_channel" };

    // 1. dedupe: o provedor reenviou? (a chave única em messages é a garantia final)
    const [dup] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), eq(messages.externalId, event.externalId)))
      .limit(1);
    if (dup) return { kind: "ignored", reason: "duplicate" };

    // 2. contato (Instagram ainda não tem provedor de entrada; só endereço de telefone vira contato)
    if (channel.type === "instagram") return { kind: "ignored", reason: "unsupported_address" };
    const upserted = await upsertContactByPhone(tx, organizationId, { phone: event.from, name: event.name, source: "inbound" });
    if (!upserted) {
      deps.log.warn("conversations.inbound.invalid_phone", { channelId: channel.id });
      return { kind: "ignored", reason: "invalid_phone" };
    }
    const contact = upserted.contact;
    if (upserted.created) {
      const stage1 = firstStageTag(await loadTags(tx, { organizationId }));
      if (stage1) await setFunnelStage(tx, organizationId, contact.id, stage1.id, stage1.name);
    } else if (event.name?.trim() && contact.phone && contact.name === contact.phone) {
      await tx.update(contacts).set({ name: event.name.trim().slice(0, 120), updatedAt: now }).where(eq(contacts.id, contact.id));
    }
    const text = event.text?.trim() ? event.text : undefined;

    // 3. opt-out PRIMEIRO: SAIR/PARAR/CANCELAR bloqueia disparos para sempre, antes de qualquer outra regra
    const classification = classifyInbound(text);
    if (classification.optOut && text) await registerOptOut(tx, organizationId, contact.id, text, now);

    // 4. resposta ao convite de consentimento (só existe se um convite foi enviado e ainda vale)
    let consent: "granted" | "denied" | null = null;
    if (!classification.optOut && text) {
      const [row] = await tx.select().from(consents).where(and(eq(consents.organizationId, organizationId), eq(consents.contactId, contact.id))).limit(1);
      if (row && row.inviteSentAt && effectiveConsentStatus(row, now) === "pending") {
        const reply = await registerConsentReply(tx, organizationId, contact.id, text, now);
        if (reply.handled && reply.intent && reply.intent !== "ambiguous") consent = reply.intent;
      }
    }

    // 5. conversa
    const { conv, created, reopened } = await findOrCreateConversation(tx, deps, organizationId, channel, contact.id, now);

    // 6. grava a mensagem (idempotente por canal+externalId)
    // arquivo de tipo não aceito (ou com conteúdo diferente do tipo): vira aviso em texto, sem guardar nada
    const unsupportedFile = prepared.state === "unsupported";
    const kind = event.kind === "other" || unsupportedFile ? "text" : event.kind;
    const body = unsupportedFile
      ? `${text ? `${text}
` : ""}[arquivo não suportado]`
      : event.kind === "other"
        ? (text ?? "[tipo de mensagem não suportado]")
        : (text ?? "");
    const file = prepared.state === "stored" ? prepared.file : null;
    const createdAt = new Date(Math.min(new Date(event.at).getTime(), now.getTime()));
    const stored = await tx
      .insert(messages)
      .values({
        id: newId(),
        organizationId,
        conversationId: conv.id,
        channelId: channel.id,
        direction: "in",
        kind,
        externalId: event.externalId,
        body,
        media:
          event.kind === "text" || event.kind === "other" || unsupportedFile
            ? null
            : {
                fileName: file?.fileName ?? null,
                mimeType: file?.mimeType ?? MEDIA_MIME[event.kind] ?? "application/octet-stream",
                sizeBytes: file?.sizeBytes ?? null,
                durationSeconds: null,
                url: null,
                mediaId: file?.id ?? null,
                mediaRef: event.mediaRef ?? null,
              },
        senderKind: "contact",
        senderName: contact.name,
        createdAt,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });
    const messageId = stored[0]?.id;
    if (!messageId) return { kind: "ignored", reason: "duplicate" };
    if (file) await linkToMessage(tx, file.id, messageId);

    // 7. contabilidade da conversa
    const activeAgent = await loadActiveAgent(tx, organizationId, conv.agentId);
    const convMode = modeOf(conv);
    const next = statusAfterInbound({ status: statusOf(conv), mode: convMode, assigneeId: conv.assigneeId }, activeAgent !== null);
    const queuedNow = next.queued && conv.waitingSince === null;
    const waitingSince = next.queued ? (conv.waitingSince ?? now) : null;
    const patch: PgUpdateSetSource<typeof conversations> = {
      status: next.status,
      waitingSince,
      unreadCount: sql`${conversations.unreadCount} + 1`,
      lastMessageAt: createdAt,
      lastMessagePreview: previewOf(body),
      lastMessageKind: lastMessageKindOf(kind),
      lastMessageFileName: file?.fileName ?? null,
      lastMessageDurationSeconds: null,
      lastMessageDirection: "in",
      lastInboundAt: createdAt,
      updatedAt: now,
      ...(event.windowExpiresAt ? { windowExpiresAt: new Date(event.windowExpiresAt) } : {}),
    };
    await tx.update(conversations).set(patch).where(eq(conversations.id, conv.id));
    await touchContactInteraction(tx, organizationId, contact.id, now);
    if (reopened) {
      await addEvent(tx, conv, REOPEN_STATUS_NOTE, now);
      await auditState(tx, conv, { from: "resolved", to: next.status, event: "customer_message", actor: "customer" });
    } else if (created) {
      await auditState(tx, conv, { from: "resolved", to: next.status, event: "customer_message", actor: "customer", reason: "conversa nova" });
    } else if (conv.status !== next.status) {
      await auditState(tx, conv, { from: conv.status, to: next.status, event: "customer_message", actor: "customer" });
    }
    if (queuedNow) await auditState(tx, conv, { from: next.status, to: "handoff_requested", event: "handoff_requested", actor: "system", reason: "modo sem IA: conversa na fila da equipe" });

    // avisos só com ids (publicados depois do commit): mensagem nova e, se a conversa nasceu, voltou ou entrou na fila, ela mudou
    queueRealtime(tx, organizationId, { type: "conversation.message", conversationId: conv.id, direction: "in" });
    if (reopened) queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: conv.id, reason: "reopened" });
    else if (queuedNow || (created && next.queued)) queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: conv.id, reason: "queue" });
    else if (created || conv.status !== next.status) queueRealtime(tx, organizationId, { type: "conversation.updated", conversationId: conv.id, reason: "other" });
    // o painel do Início conta a fila e as conversas abertas
    if (reopened || created || queuedNow) queueRealtime(tx, organizationId, { type: "home.invalidate" });

    const sendingPaused = await isSendingPausedForOrg(tx, now);
    const freshConv: ConversationRow = { ...conv, status: next.status, waitingSince };

    // 8. pedido de saída / resposta de consentimento: confirma uma vez e PARA (sem boas-vindas, sem IA)
    if (classification.optOut || consent) {
      const confirmation = classification.optOut || consent === "denied" ? (classification.optOut ? OPT_OUT_CONFIRMATION : CONSENT_DENIED_REPLY) : CONSENT_GRANTED_REPLY;
      await addEvent(tx, conv, classification.optOut ? "Cliente pediu para não receber mais mensagens" : consent === "granted" ? "Cliente aceitou receber mensagens" : "Cliente recusou receber mensagens", now);
      if (!sendingPaused) {
        await deliverOutbound(tx, {
          conv: freshConv,
          channelName: channel.name,
          to: contact.phone,
          kind: "text",
          body: confirmation,
          media: null,
          sender: { kind: "system", id: null, name: "Mensagem automática" },
          externalId: `auto:consent:${conv.id}:${event.externalId}`,
          countsAsReply: false,
          now,
        });
      }
      await tx.update(conversations).set({ aiDueAt: null }).where(eq(conversations.id, conv.id));
      return { kind: "stored", conversationId: conv.id, messageId, optOut: classification.optOut, consent, aiScheduled: null };
    }

    // 9. mensagens automáticas do canal (boas-vindas / fora do horário)
    const { hours, timeZone } = await businessHoursFor(tx, organizationId, conv.teamId);
    const withinHours = isWithinBusinessHours(now, toAiHours(hours, timeZone));
    const auto = decideAutoMessage({
      replyMode: channel.replyMode,
      isNewConversation: created,
      withinHours,
      welcome: channel.welcomeMessage,
      outOfHours: channel.outOfHoursMessage,
      outOfHoursNoticeAt: conv.outOfHoursNoticeAt,
      now,
    });
    if (auto && !sendingPaused) {
      const delivered = await deliverOutbound(tx, {
        conv: freshConv,
        channelName: channel.name,
        to: contact.phone,
        kind: "text",
        body: auto === "welcome" ? channel.welcomeMessage : channel.outOfHoursMessage,
        media: null,
        sender: { kind: "system", id: null, name: "Mensagem automática" },
        externalId: `auto:${auto}:${conv.id}:${event.externalId}`,
        countsAsReply: false,
        now,
      });
      if (auto === "out_of_hours" && delivered.ok) await tx.update(conversations).set({ outOfHoursNoticeAt: now }).where(eq(conversations.id, conv.id));
    }

    // 10. o cliente respondeu a um lembrete? ("1"/"sim" confirma, "2"/"remarcar" pede remarcação): confirma e não vai para a IA
    const reminder = text ? await applyReminderFromReply(tx, conv, contact.id, text, organizationId, timeZone, now) : null;
    if (reminder) {
      if (!sendingPaused) {
        await deliverOutbound(tx, {
          conv: freshConv,
          channelName: channel.name,
          to: contact.phone,
          kind: "text",
          body: reminder === "confirmed" ? REMINDER_CONFIRMED_REPLY : REMINDER_RESCHEDULE_REPLY,
          media: null,
          sender: { kind: "system", id: null, name: "Mensagem automática" },
          externalId: `auto:reminder:${conv.id}:${event.externalId}`,
          countsAsReply: false,
          now,
        });
      }
      await tx.update(conversations).set({ aiDueAt: null }).where(eq(conversations.id, conv.id));
      return { kind: "stored", conversationId: conv.id, messageId, optOut: false, consent: null, aiScheduled: null };
    }

    // 11. IA: responde (modo IA), sugere (Copiloto) ou nada (Só humano → fila da equipe, já tratada acima)
    const runMode = shouldRunAi({ mode: convMode, status: next.status }, activeAgent !== null);
    if (!runMode || (runMode === "live" && sendingPaused)) {
      if (conv.aiDueAt) await tx.update(conversations).set({ aiDueAt: null }).where(eq(conversations.id, conv.id));
      return { kind: "stored", conversationId: conv.id, messageId, optOut: false, consent: null, aiScheduled: null };
    }
    const due = computeAiDue({ now, burstStartedAt: conv.aiBurstStartedAt, windowMs: deps.config.CONVERSATIONS_BURST_WINDOW_MS, maxWaitMs: deps.config.CONVERSATIONS_BURST_MAX_WAIT_MS });
    await tx.update(conversations).set({ aiDueAt: due.dueAt, aiBurstStartedAt: due.startedAt }).where(eq(conversations.id, conv.id));
    return { kind: "stored", conversationId: conv.id, messageId, optOut: false, consent: null, aiScheduled: { delayMs: Math.max(0, due.dueAt.getTime() - now.getTime()) } };
  });
  return outcome;
}

async function applyReminderFromReply(tx: Transaction, conv: ConversationRow, contactId: string, text: string, organizationId: string, timeZone: string, now: Date): Promise<"confirmed" | "reschedule" | null> {
  if (!interpretReminderReply(text)) return null;
  const [next] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, organizationId),
        eq(appointments.contactId, contactId),
        inArray(appointments.status, ["pending", "confirmed", "reschedule"]),
        gte(appointments.startsAt, new Date(now.getTime() - 2 * 3_600_000)),
        lte(appointments.startsAt, new Date(now.getTime() + 48 * 3_600_000)),
      ),
    )
    .orderBy(asc(appointments.startsAt))
    .limit(1);
  if (!next) return null;
  const ctx: ServiceCtx = { organizationId, userId: "system", userName: "Sistema", timeZone, orgName: "" };
  const result = await applyReminderReply(tx, ctx, next.id, text, now);
  if (!result.ok) return null;
  const status = result.data.status === "confirmed" ? "confirmed" : "reschedule";
  await addEvent(tx, conv, status === "confirmed" ? "Cliente confirmou o agendamento pela resposta" : "Cliente pediu para remarcar o agendamento", now);
  return status;
}

/** Handler registrado em `lib/inbound` (Canais despacha, Conversas trata). Eventos de conexão são do módulo Canais. */
export async function handleInbound(deps: InboundDeps, context: InboundContext) {
  const { event } = context;
  if (event.type === "status") await applyStatusEvent(deps, context, event);
  else if (event.type === "message") await handleMessage(deps, context, event);
}

