import {
  contactOriginSchema,
  inviteIneligibility,
  inviteIneligibleReasonSchema,
  type InviteIneligibleReason,
  type InviteOverview,
  type InviteRequest,
  type InviteResult,
} from "@duckzap/contracts/contacts";
import { schema, withOrg, type Database, type Transaction } from "@duckzap/db";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { dayStartUtc, todayIn } from "../appointments/time";
import { assignToDays, planInvites } from "./invite-plan";
import { consentToDto, recordContactEvent } from "./service";
import { toInviteChannel, type ContactsPorts, type InviteChannelInfo, type InviteJob } from "./ports";
import { chunk, fail, newId, ok, type Result, type ServiceCtx } from "./result";

const { contacts, consents } = schema;

/** Texto base do convite (§5.7 item 7): identificação + motivo + pergunta. Sem oferta, preço, link ou mídia. */
export const INVITE_TEMPLATE =
  "Oi, {nome}! Aqui é a {empresa}. Podemos te enviar novidades e lembretes por aqui? Responda SIM para aceitar ou NÃO para não receber.";

export const INVITE_SEND_WINDOW = { start: "08:00", end: "20:00", sundays: false } as const;
const ELIGIBLE_IDS_LIMIT = 5000;

export function renderInvite(template: string, orgName: string, contactName: string) {
  const first = contactName.trim().split(/\s+/)[0] || contactName;
  return template.replaceAll("{empresa}", orgName).replaceAll("{nome}", first);
}

async function invitesSentToday(tx: Transaction, ctx: ServiceCtx, now: Date) {
  const since = dayStartUtc(todayIn(ctx.timeZone, now), ctx.timeZone);
  const rows = await tx
    .select({ channelId: consents.channelId, n: count() })
    .from(consents)
    .where(and(eq(consents.organizationId, ctx.organizationId), eq(consents.method, "invite"), gte(consents.inviteQueuedAt, since)))
    .groupBy(consents.channelId);
  return new Map(rows.map((r) => [r.channelId, r.n]));
}

/** Visão da tela "Convidar contatos": números, limites do dia e quem pode (ou não) receber o convite. */
export async function getInviteOverview(
  tx: Transaction,
  ctx: ServiceCtx,
  channelInfos: readonly InviteChannelInfo[],
  now = new Date(),
): Promise<InviteOverview> {
  const sent = await invitesSentToday(tx, ctx, now);

  // mesma precedência de `inviteIneligibility` (contrato), expressa em SQL para não carregar a base inteira
  const reasonSql = sql<string | null>`case
    when ${consents.status} in ('granted','denied') then 'has_consent'
    when ${consents.id} is not null then 'already_invited'
    when ${contacts.phone} is null then 'no_phone'
    when ${contacts.origin} is null then 'no_origin'
    when ${contacts.origin} = 'inbound' then 'inbound'
    else null end`;
  const grouped = await tx
    .select({ reason: reasonSql, n: count() })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(eq(contacts.organizationId, ctx.organizationId))
    .groupBy(reasonSql);

  const ineligibleCounts: Record<InviteIneligibleReason, number> = {
    already_invited: 0,
    has_consent: 0,
    no_origin: 0,
    inbound: 0,
    no_phone: 0,
  };
  for (const row of grouped) {
    const reason = inviteIneligibleReasonSchema.safeParse(row.reason);
    if (reason.success) ineligibleCounts[reason.data] = row.n;
  }

  const eligible = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(and(eq(contacts.organizationId, ctx.organizationId), sql`${reasonSql} is null`))
    .orderBy(contacts.createdAt)
    .limit(ELIGIBLE_IDS_LIMIT);

  return {
    channels: channelInfos.map((info) => toInviteChannel(info, sent.get(info.id) ?? 0)),
    messageTemplate: renderInvite(INVITE_TEMPLATE, ctx.orgName, "{nome}"),
    autoInviteEnabled: false,
    sendWindow: { ...INVITE_SEND_WINDOW },
    eligibleContactIds: eligible.map((e) => e.id),
    ineligibleCounts,
  };
}

/**
 * Enfileira convites. O registro em `consents` (uma linha por contato) nasce aqui, na mesma transação do
 * enfileiramento: é ele que garante "um convite só, para sempre", mesmo com dois cliques simultâneos.
 * O worker deve conferir, antes de enviar, que a linha existe, está `pending` e ainda sem `invite_sent_at`.
 */
export async function inviteContacts(
  tx: Transaction,
  ctx: ServiceCtx,
  request: InviteRequest,
  channelInfos: readonly InviteChannelInfo[],
  queue: ContactsPorts["queue"],
  now = new Date(),
): Promise<Result<InviteResult, "channel_unavailable" | "none_eligible">> {
  const channelInfo = channelInfos.find((c) => c.id === request.channelId);
  if (!channelInfo || !channelInfo.connected) {
    return fail("channel_unavailable", "Este número está desconectado. Reconecte em Canais ou escolha outro.");
  }

  const ids = [...new Set(request.contactIds)];
  const rows = await tx
    .select({ contact: contacts, consent: consents })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(and(eq(contacts.organizationId, ctx.organizationId), inArray(contacts.id, ids)));

  const skipped: InviteResult["skipped"] = [];
  const eligible: (typeof contacts.$inferSelect)[] = [];
  for (const row of rows) {
    const reason = inviteIneligibility({
      consent: consentToDto(row.consent, now),
      origin: contactOriginSchema.nullable().catch(null).parse(row.contact.origin),
      phone: row.contact.phone,
    });
    if (reason) skipped.push({ contactId: row.contact.id, reason });
    else eligible.push(row.contact);
  }
  if (eligible.length === 0) return fail("none_eligible", "Nenhum dos contatos escolhidos pode receber o convite.");

  const channel = toInviteChannel(channelInfo, (await invitesSentToday(tx, ctx, now)).get(channelInfo.id) ?? 0);
  const plan = planInvites({
    count: eligible.length,
    invitesSentToday: channel.invitesSentToday,
    messagesSentToday: channel.messagesSentToday,
    inviteDailyLimit: channel.inviteDailyLimit,
    channelDailyLimit: channel.channelDailyLimit,
    today: todayIn(ctx.timeZone, now),
    skipSundays: !INVITE_SEND_WINDOW.sundays,
  });
  if (plan.schedule.length === 0) return fail("channel_unavailable", "Este número não pode enviar convites agora. Tente de novo amanhã.");

  const jobs: InviteJob[] = [];
  const inserted = new Set<string>();
  for (const day of assignToDays(eligible, plan.schedule)) {
    for (const batch of chunk(day.items, 500)) {
      const created = await tx
        .insert(consents)
        .values(
          batch.map((c) => ({
            id: newId(),
            organizationId: ctx.organizationId,
            contactId: c.id,
            status: "pending",
            method: "invite",
            inviteText: renderInvite(INVITE_TEMPLATE, ctx.orgName, c.name),
            inviteQueuedAt: now,
            inviteScheduledFor: day.date,
            channelId: channelInfo.id,
            channelName: channelInfo.name,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing({ target: [consents.organizationId, consents.contactId] })
        .returning({ contactId: consents.contactId, inviteText: consents.inviteText });
      const textById = new Map(created.map((c) => [c.contactId, c.inviteText]));
      for (const c of batch) {
        const text = textById.get(c.id);
        if (text == null || !c.phone) continue; // outra requisição criou o convite antes: não duplica
        inserted.add(c.id);
        jobs.push({ organizationId: ctx.organizationId, contactId: c.id, channelId: channelInfo.id, to: c.phone, text, runOn: day.date });
      }
    }
  }
  for (const c of eligible) {
    if (inserted.has(c.id)) await recordContactEvent(tx, ctx.organizationId, c.id, "consent", "Convite de consentimento na fila", `Pelo número ${channelInfo.name}`);
    else skipped.push({ contactId: c.id, reason: "already_invited" });
  }
  if (jobs.length === 0) return fail("none_eligible", "Nenhum dos contatos escolhidos pode receber o convite.");
  await queue.enqueueInvites(jobs);
  return ok({ queued: jobs.length, days: plan.days, skipped });
}

// Pontos de entrada que juntam porta de canais + transação ------------------------------------------------------

export async function inviteOverview(db: Database, ctx: ServiceCtx, ports: ContactsPorts, now = new Date()) {
  const infos = await ports.channels.listInviteChannels(ctx.organizationId);
  return withOrg(db, ctx.organizationId, (tx) => getInviteOverview(tx, ctx, infos, now));
}

export async function sendInvites(db: Database, ctx: ServiceCtx, ports: ContactsPorts, request: InviteRequest, now = new Date()) {
  const infos = await ports.channels.listInviteChannels(ctx.organizationId);
  // o enfileiramento acontece dentro da transação: se falhar, nenhum convite fica "gasto" sem job
  return withOrg(db, ctx.organizationId, (tx) => inviteContacts(tx, ctx, request, infos, ports.queue, now));
}
