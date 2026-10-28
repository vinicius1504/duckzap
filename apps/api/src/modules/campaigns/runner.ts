import { schema, withOrg, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { OutboundMessage } from "../../lib/messaging";
import { isSendingPausedForOrg, sendViaChannel } from "../channels/sending";
import { evaluateBreaker, classifyFailure, type Outcome } from "./engine/breaker";
import { addDays, isWithinWindow, localDate, nextWindowOpening, zonedToUtc, type SendWindow } from "./engine/calendar";
import { checkSendGate, numberAgeDays } from "./engine/limits";
import { nextInterval, officialInterval, parseSamplerState, typingDurationMs, type SamplerState } from "./engine/intervals";
import { composeBody, degradeToText, drawFromBag, ensureOptOut, renderVariables, type BankEntry } from "./engine/variation";
import type { CampaignsRuntime, TickJob } from "./ports";
import { channelKindOf, channelUsage, findChannelRow, loadOrgInfo, type CampaignRow } from "./repo";
import { generateOneVariation } from "./variation-gen";

const { campaigns, campaignRecipients, campaignVariations, campaignTemplates, contacts, consents, appointments } = schema;

// Motor de envio seguro (§5.7). `runCampaignTick` é o que o futuro worker chama a cada poucos segundos (e quando um job
// atrasado vence). Cada chamada envia NO MÁXIMO uma mensagem por campanha: o espaçamento vem de `next_send_at`
// (intervalo sorteado, pausa longa, janela, limites), nunca de um `sleep` longo. Idempotente: repetir o tick no mesmo
// instante não envia de novo, porque o primeiro já empurrou `next_send_at` para o futuro (e a linha da campanha fica travada).

export const TICK_JOB = "campaign.tick";
/** Reserva sem desfecho há mais que isto vira "falha: resultado desconhecido" (nunca reenvia: evita mensagem duplicada). */
export const STALE_CLAIM_MS = 10 * 60_000;

export type TickSummary = { organizations: number; campaigns: number; sent: number; failed: number; paused: number; completed: number; waiting: number };

const emptySummary = (): TickSummary => ({ organizations: 0, campaigns: 0, sent: 0, failed: 0, paused: 0, completed: 0, waiting: 0 });

type Sink = TickSummary;

/** Empresas com campanhas vencidas (função SECURITY DEFINER: o worker não tem sessão de empresa). */
export async function discoverDueOrganizations(rt: CampaignsRuntime, limit = 100): Promise<string[]> {
  try {
    const rows = await rt.db.execute<{ organization_id: string }>(sql`select organization_id from public.dz_orgs_with_due_campaigns(${limit})`);
    return rows.map((r) => r.organization_id);
  } catch (error) {
    rt.log.error("campaigns.discover_failed", { error: error instanceof Error ? error.name : "unknown" });
    return [];
  }
}

export async function runCampaignTick(
  rt: CampaignsRuntime,
  now: Date = rt.now(),
  options: { organizationIds?: readonly string[] } = {},
): Promise<TickSummary> {
  const summary = emptySummary();
  const orgIds = options.organizationIds ?? (await discoverDueOrganizations(rt));
  for (const organizationId of orgIds) {
    summary.organizations++;
    try {
      const due = await withOrg(rt.db, organizationId, (tx) =>
        tx
          .select({ id: campaigns.id })
          .from(campaigns)
          .where(and(inArray(campaigns.status, ["scheduled", "sending"]), sql`(${campaigns.nextSendAt} is null or ${campaigns.nextSendAt} <= ${now.toISOString()}::timestamptz)`))
          .orderBy(asc(campaigns.nextSendAt))
          .limit(50),
      );
      for (const { id } of due) await tickCampaign(rt, { organizationId, campaignId: id }, now, summary);
    } catch (error) {
      rt.log.error("campaigns.tick_org_failed", { organizationId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return summary;
}

/** Registra o consumidor dos jobs atrasados `campaign.tick` na fila do runtime (em memória hoje; BullMQ Worker depois). */
export function registerTickConsumer(rt: CampaignsRuntime) {
  rt.queue.process(TICK_JOB, async (job: TickJob) => {
    await tickCampaign(rt, job, rt.now(), emptySummary());
  });
}

// ---------- fase A: decidir e reservar (numa transação, com a campanha travada) ----------

type SendPlan = {
  kind: "send";
  recipientId: string;
  channelId: string;
  channelProvider: string;
  to: string;
  message: OutboundMessage;
  renderedText: string;
  nextAt: Date;
  timeZone: string;
};
type Prepared = { kind: "skip" } | { kind: "wait"; at: Date } | { kind: "paused" } | { kind: "completed" } | SendPlan;

type EngineState = {
  sampler?: SamplerState;
  bag?: string[];
  lastVariationId?: string | null;
  recentTexts?: string[];
  breakerSince?: string;
};

function readState(raw: Record<string, unknown>): EngineState {
  return raw as EngineState;
}

async function recentOutcomes(tx: Transaction, campaignId: string, since: Date | null): Promise<Outcome[]> {
  const rows = await tx
    .select({ status: campaignRecipients.status })
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, campaignId), isNotNull(campaignRecipients.attemptedAt), since ? gte(campaignRecipients.attemptedAt, since) : undefined))
    .orderBy(desc(campaignRecipients.attemptedAt))
    .limit(20);
  return rows.map((r) => (r.status === "failed" ? "failed" : r.status === "opted_out" ? "opt_out" : "ok"));
}

async function pauseCampaignRow(tx: Transaction, id: string, reason: NonNullable<CampaignRow["pauseReason"]>, detail: string, now: Date) {
  await tx
    .update(campaigns)
    .set({ status: "paused", pauseReason: reason, pauseDetail: detail, nextSendAt: null, updatedAt: now })
    .where(and(eq(campaigns.id, id), inArray(campaigns.status, ["scheduled", "sending"])));
}

function formatLocalDay(date: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(date);
  return p;
}

async function lastVisitOf(tx: Transaction, contactId: string, fallback: Date | null, timeZone: string, now: Date) {
  const [row] = await tx
    .select({ at: sql<Date | null>`max(${appointments.startsAt})` })
    .from(appointments)
    .where(and(eq(appointments.contactId, contactId), eq(appointments.status, "done"), lt(appointments.startsAt, now)));
  const at = row?.at ? new Date(row.at) : fallback;
  return at ? formatLocalDay(at, timeZone) : null;
}

async function prepare(rt: CampaignsRuntime, tx: Transaction, job: TickJob, now: Date): Promise<Prepared> {
  const [c] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, job.campaignId), eq(campaigns.organizationId, job.organizationId)))
    .for("update", { skipLocked: true })
    .limit(1);
  if (!c) return { kind: "skip" };
  if (c.status !== "scheduled" && c.status !== "sending") return { kind: "skip" };
  if (c.nextSendAt && c.nextSendAt.getTime() > now.getTime()) return { kind: "skip" };

  const org = await loadOrgInfo(tx, job.organizationId);
  const tz = org.timeZone;
  const pause = async (reason: NonNullable<CampaignRow["pauseReason"]>, detail: string): Promise<Prepared> => {
    await pauseCampaignRow(tx, c.id, reason, detail, now);
    return { kind: "paused" };
  };

  // plano expirado: bloqueado no servidor (também em sendViaChannel)
  if (await isSendingPausedForOrg(tx, now)) return pause("subscription_expired", "O plano expirou. Renove a assinatura para retomar.");
  const channel = await findChannelRow(tx, job.organizationId, c.channelId);
  const kind = channel ? channelKindOf(channel) : null;
  if (!channel || !kind) return pause("channel_disconnected", "O canal da campanha não existe mais.");
  if (channel.status === "banned") return pause("provider_restriction", "O provedor informou que o número foi restringido ou banido.");
  if (channel.status !== "connected") return pause("channel_disconnected", "O canal desconectou durante o envio.");

  const window: SendWindow = { start: c.windowStart, end: c.windowEnd, skipSundaysAndHolidays: c.skipSundaysAndHolidays, timeZone: tz };
  if (!isWithinWindow(now, window)) {
    const at = nextWindowOpening(now, window);
    await tx.update(campaigns).set({ nextSendAt: at, updatedAt: now }).where(eq(campaigns.id, c.id));
    return { kind: "wait", at };
  }

  // reservas sem desfecho (processo caiu entre a reserva e a resposta do provedor): falha, nunca reenvio
  await tx
    .update(campaignRecipients)
    .set({ status: "failed", errorCode: "unknown_outcome", reason: "Resultado do envio desconhecido (o processo parou durante o envio). Não reenviado para evitar mensagem duplicada.", updatedAt: now })
    .where(and(eq(campaignRecipients.campaignId, c.id), eq(campaignRecipients.status, "queued"), isNotNull(campaignRecipients.attemptedAt), lt(campaignRecipients.attemptedAt, new Date(now.getTime() - STALE_CLAIM_MS))));

  const state = readState(c.engineState);
  const since = state.breakerSince ? new Date(state.breakerSince) : null;
  const verdict = evaluateBreaker({ channelConnected: true, providerRestriction: false, recent: await recentOutcomes(tx, c.id, since) });
  if (verdict.pause) return pause(verdict.reason, verdict.detail);

  // limites duros por número (50/dia com aquecimento, ~15/h)
  const usage = await channelUsage(tx, channel.id, now, tz);
  const gate = checkSendGate(kind, numberAgeDays(channel.createdAt, now), usage, now);
  if (!gate.allowed) {
    const from = gate.reason === "daily_limit" ? zonedToUtc(addDays(localDate(now, tz), 1), "00:00", tz) : (gate.retryAt as Date);
    const at = nextWindowOpening(from, window);
    await tx.update(campaigns).set({ nextSendAt: at, updatedAt: now }).where(eq(campaigns.id, c.id));
    return { kind: "wait", at };
  }

  // próximo destinatário; quem saiu/retirou o aceite desde o disparo é descartado AGORA (opt-out vale na hora)
  let candidate: { r: typeof campaignRecipients.$inferSelect; name: string; phone: string | null; lastInteractionAt: Date | null } | undefined;
  for (let guard = 0; guard < 50 && !candidate; guard++) {
    const [row] = await tx
      .select({ r: campaignRecipients, name: contacts.name, phone: contacts.phone, lastInteractionAt: contacts.lastInteractionAt, consent: consents.status })
      .from(campaignRecipients)
      .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
      .leftJoin(consents, eq(consents.contactId, campaignRecipients.contactId))
      .where(and(eq(campaignRecipients.campaignId, c.id), eq(campaignRecipients.status, "queued"), isNull(campaignRecipients.attemptedAt)))
      .orderBy(asc(campaignRecipients.position))
      .limit(1);
    if (!row) break;
    if (row.consent !== "granted" || !row.phone) {
      const denied = row.consent === "denied";
      await tx
        .update(campaignRecipients)
        .set({
          status: denied ? "opted_out" : "skipped",
          reason: denied ? "Pediu para não receber antes do envio" : !row.phone ? "Contato sem telefone" : "Aceite de recebimento não está mais valendo",
          optedOutAt: denied ? now : null,
          updatedAt: now,
        })
        .where(eq(campaignRecipients.id, row.r.id));
      continue;
    }
    candidate = row;
  }
  if (!candidate) {
    await tx.update(campaigns).set({ status: "completed", finishedAt: now, nextSendAt: null, updatedAt: now }).where(eq(campaigns.id, c.id));
    return { kind: "completed" };
  }

  const vars = { name: candidate.name, orgName: org.name, lastVisit: c.body.includes("{ultima_visita}") || c.optOutLine.includes("{ultima_visita}") ? await lastVisitOf(tx, candidate.r.contactId, candidate.lastInteractionAt, tz, now) : null };
  const next: EngineState = { ...state };
  let renderedText: string;
  let message: OutboundMessage;
  let variationId: string | null = null;
  let variationNumber: number | null = null;
  let delaySeconds: number;
  let longPauseSeconds: number | null = null;

  if (kind === "whatsapp_official") {
    // API oficial: SÓ modelo aprovado, sem variação por IA (§3.6)
    const [tpl] = c.officialTemplateId ? await tx.select().from(campaignTemplates).where(eq(campaignTemplates.id, c.officialTemplateId)).limit(1) : [];
    if (!tpl || tpl.metaStatus !== "approved" || !tpl.metaName) return pause("manual", "O modelo aprovado da Meta não está mais disponível.");
    const params = tpl.metaParams.map((p) => renderVariables(p, vars));
    renderedText = tpl.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? "");
    message = {
      externalId: candidate.r.externalId,
      to: candidate.phone as string,
      kind: "template",
      template: { name: tpl.metaName, language: tpl.metaLanguage ?? "pt_BR", ...(params.length ? { bodyParams: params } : {}) },
    };
    delaySeconds = officialInterval(rt.rng);
  } else {
    const bankRows = await tx.select().from(campaignVariations).where(eq(campaignVariations.campaignId, c.id)).orderBy(asc(campaignVariations.position));
    const bank: BankEntry[] = bankRows.filter((v) => v.review === "approved" && v.issues.length === 0).map((v) => ({ id: v.id, text: v.text }));
    const recentTexts = next.recentTexts ?? [];
    let raw: string | null = null;
    if (c.variationMode === "per_message") {
      // variação nova por mensagem, mesmo validador; reprovou 2x (ou IA fora) → banco aprovado
      raw = await generateOneVariation({ llm: rt.llm, organizationId: job.organizationId }, c.body, c.optOutLine, recentTexts);
    }
    if (raw === null) {
      const drawn = drawFromBag(bank, next.bag ?? [], next.lastVariationId ?? null, rt.rng);
      if (drawn) {
        raw = drawn.entry.text;
        variationId = drawn.entry.id;
        variationNumber = bankRows.findIndex((v) => v.id === drawn.entry.id) + 1;
        next.bag = drawn.bag;
        next.lastVariationId = drawn.entry.id;
      } else {
        raw = ensureOptOut(c.body, c.optOutLine); // sem banco utilizável: a base, sempre com a linha de saída
      }
    } else {
      next.lastVariationId = null;
    }
    next.recentTexts = [...recentTexts, raw].slice(-3);
    // botões/lista: nenhum provedor QR os entrega de forma estável → opções numeradas ANTES da linha de saída
    renderedText = renderVariables(composeBody(raw, c.optOutLine, degradeToText({ type: c.messageType as "text", buttons: c.buttons, listButtonLabel: c.listButtonLabel, listItems: c.listItems })), vars);
    message = { externalId: candidate.r.externalId, to: candidate.phone as string, kind: "text", text: renderedText };
    const sampler = parseSamplerState(next.sampler, rt.rng);
    const drawn = nextInterval({ minSeconds: c.intervalMinSeconds, maxSeconds: c.intervalMaxSeconds }, sampler, rt.rng);
    next.sampler = drawn.state;
    delaySeconds = drawn.seconds;
    longPauseSeconds = drawn.longPauseSeconds;
  }

  // dia de envio da campanha (1 = primeiro dia com tentativa)
  const days = await tx
    .selectDistinct({ day: sql<string>`to_char((${campaignRecipients.attemptedAt} at time zone ${tz})::date, 'YYYY-MM-DD')` })
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, c.id), isNotNull(campaignRecipients.attemptedAt)));
  const today = localDate(now, tz);
  const dayIndex = days.some((d) => d.day === today) ? days.length : days.length + 1;

  const claimed = await tx
    .update(campaignRecipients)
    .set({
      attemptedAt: now,
      renderedText,
      variationId,
      variationNumber,
      intervalSeconds: delaySeconds,
      longPauseSeconds,
      dayIndex,
      updatedAt: now,
    })
    .where(and(eq(campaignRecipients.id, candidate.r.id), eq(campaignRecipients.status, "queued"), isNull(campaignRecipients.attemptedAt)))
    .returning({ id: campaignRecipients.id });
  if (claimed.length === 0) return { kind: "skip" };

  const nextAt = new Date(now.getTime() + (delaySeconds + (longPauseSeconds ?? 0)) * 1000);
  await tx
    .update(campaigns)
    .set({ status: "sending", startedAt: c.startedAt ?? now, nextSendAt: nextAt, engineState: next as Record<string, unknown>, updatedAt: now })
    .where(eq(campaigns.id, c.id));

  return {
    kind: "send",
    recipientId: candidate.r.id,
    channelId: channel.id,
    channelProvider: channel.provider,
    to: candidate.phone as string,
    // QR: "digitando…" proporcional ao texto vai NA mensagem (a Evolution mostra a presença e só então entrega);
    // `sendViaChannel` descarta o campo para provedor sem a capacidade `presence`
    message: kind === "whatsapp_qr" ? { ...message, typingMs: typingDurationMs(renderedText, rt.rng) } : message,
    renderedText,
    nextAt,
    timeZone: tz,
  };
}

// ---------- fase C: enviar e registrar o desfecho ----------

async function deliver(rt: CampaignsRuntime, job: TickJob, plan: SendPlan, now: Date, sink: Sink) {
  await withOrg(rt.db, job.organizationId, async (tx) => {
    const result = await sendViaChannel(tx, plan.channelId, plan.message, rt.channels);
    const release = () =>
      tx
        .update(campaignRecipients)
        .set({ attemptedAt: null, renderedText: null, variationId: null, variationNumber: null, intervalSeconds: null, longPauseSeconds: null, dayIndex: null, updatedAt: now })
        .where(eq(campaignRecipients.id, plan.recipientId));

    if (result.ok) {
      await tx
        .update(campaignRecipients)
        .set({ status: "sent", sentAt: now, providerMessageId: result.providerMessageId, errorCode: null, updatedAt: now })
        .where(eq(campaignRecipients.id, plan.recipientId));
      sink.sent++;
    } else {
      const kind = classifyFailure({ code: result.code, message: result.message });
      if (kind === "transient") {
        await release();
        if (result.code === "disconnected") {
          await pauseCampaignRow(tx, job.campaignId, "channel_disconnected", "O canal desconectou durante o envio.", now);
          sink.paused++;
        } else if (result.code === "plan_paused") {
          await pauseCampaignRow(tx, job.campaignId, "subscription_expired", "O plano expirou. Renove a assinatura para retomar.", now);
          sink.paused++;
        } else {
          // limite de taxa do canal: tenta de novo em instantes, sem contar como falha
          await tx.update(campaigns).set({ nextSendAt: new Date(now.getTime() + 20_000), updatedAt: now }).where(eq(campaigns.id, job.campaignId));
          sink.waiting++;
        }
        return;
      }
      await tx
        .update(campaignRecipients)
        .set({
          status: kind === "no_whatsapp" ? "no_whatsapp" : "failed",
          errorCode: result.code,
          reason: kind === "no_whatsapp" ? "Número sem WhatsApp" : result.message.slice(0, 300),
          updatedAt: now,
        })
        .where(eq(campaignRecipients.id, plan.recipientId));
      if (kind !== "no_whatsapp") sink.failed++;
      if (kind === "restriction") {
        await pauseCampaignRow(tx, job.campaignId, "provider_restriction", "O provedor devolveu um erro indicando restrição no número.", now);
        sink.paused++;
        return;
      }
    }

    // disjuntor logo após o desfecho (não espera o próximo tick)
    const [c] = await tx.select({ engineState: campaigns.engineState, status: campaigns.status }).from(campaigns).where(eq(campaigns.id, job.campaignId)).limit(1);
    if (c && (c.status === "sending" || c.status === "scheduled")) {
      const since = readState(c.engineState).breakerSince;
      const verdict = evaluateBreaker({ channelConnected: true, providerRestriction: false, recent: await recentOutcomes(tx, job.campaignId, since ? new Date(since) : null) });
      if (verdict.pause) {
        await pauseCampaignRow(tx, job.campaignId, verdict.reason, verdict.detail, now);
        sink.paused++;
        return;
      }
      const [left] = await tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(campaignRecipients)
        .where(and(eq(campaignRecipients.campaignId, job.campaignId), eq(campaignRecipients.status, "queued"), isNull(campaignRecipients.attemptedAt)));
      if ((left?.n ?? 0) === 0) {
        await tx.update(campaigns).set({ status: "completed", finishedAt: now, nextSendAt: null, updatedAt: now }).where(eq(campaigns.id, job.campaignId));
        sink.completed++;
      }
    }
  });
}

export async function tickCampaign(rt: CampaignsRuntime, job: TickJob, now: Date, sink: Sink): Promise<void> {
  let prepared: Prepared;
  try {
    prepared = await withOrg(rt.db, job.organizationId, (tx) => prepare(rt, tx, job, now));
  } catch (error) {
    rt.log.error("campaigns.prepare_failed", { campaignId: job.campaignId, error: error instanceof Error ? error.name : "unknown" });
    return;
  }
  sink.campaigns++;
  if (prepared.kind === "skip") return;
  if (prepared.kind === "paused") {
    sink.paused++;
    return;
  }
  if (prepared.kind === "completed") {
    sink.completed++;
    return;
  }
  if (prepared.kind === "wait") {
    sink.waiting++;
    await wake(rt, job, prepared.at, now);
    return;
  }
  try {
    await deliver(rt, job, prepared, now, sink);
  } catch (error) {
    // a reserva fica; a próxima passada a trata como "resultado desconhecido" (sem reenvio)
    rt.log.error("campaigns.deliver_failed", { campaignId: job.campaignId, error: error instanceof Error ? error.name : "unknown" });
    return;
  }
  await wake(rt, job, prepared.nextAt, now);
}

/** Agenda o próximo acordar da campanha (job atrasado). O `jobId` evita empilhar o mesmo instante duas vezes. */
async function wake(rt: CampaignsRuntime, job: TickJob, at: Date, now: Date) {
  await rt.queue.enqueue(TICK_JOB, job, { delayMs: Math.max(0, at.getTime() - now.getTime()), jobId: `${job.campaignId}:${at.getTime()}` });
}
