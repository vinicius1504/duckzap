import type {
  Audience,
  Campaign,
  CampaignChannel,
  CampaignRecipient,
  CampaignRecipientStatus,
  CampaignTemplate,
  MessageVariation,
  VariationIssue,
} from "@duckzap/contracts/campaigns";
import { schema, type Transaction } from "@duckzap/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { UUID_PATTERN } from "../channels/repo";
import type { ProviderRegistry } from "../channels/providers/registry";
import { chunk } from "../contacts/result";
import { buildListCondition } from "../contacts/filter";
import { classifyAudience, type AudienceRow, type ConsentKind } from "./engine/audience";
import { localDate, zonedToUtc, type SendWindow } from "./engine/calendar";
import { HOUR_MS, dailyLimitFor, hourlyLimitFor, numberAgeDays, type ChannelKindLike } from "./engine/limits";
import { projectDayPlan } from "./engine/schedule";
import { RECENT_DAYS, type RecentContactsPort } from "./ports";

const { campaigns, campaignRecipients, campaignVariations, campaignTemplates, channels, contacts, consents, contactLists, organization } = schema;

export type CampaignRow = typeof campaigns.$inferSelect;
export type RecipientRow = typeof campaignRecipients.$inferSelect;
export type TemplateRow = typeof campaignTemplates.$inferSelect;
export type VariationRow = typeof campaignVariations.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;

/** Quem executa o caso de uso. Vem sempre da sessão. */
export type CampaignCtx = { organizationId: string; userId: string; userName: string; timeZone: string; orgName: string };

export const isUuid = (value: string) => UUID_PATTERN.test(value);

export async function loadOrgInfo(tx: Transaction, organizationId: string) {
  // `organization` é do Better Auth e fica fora do RLS: o filtro por empresa é explícito
  const [row] = await tx.select({ name: organization.name, timeZone: organization.timeZone }).from(organization).where(eq(organization.id, organizationId)).limit(1);
  return { name: row?.name ?? "", timeZone: row?.timeZone ?? "America/Sao_Paulo" };
}

// ---------- canais ----------

export const SENDING_CHANNEL_TYPES = ["whatsapp_qr", "whatsapp_official"] as const;

export function channelKindOf(row: Pick<ChannelRow, "type">): ChannelKindLike | null {
  return row.type === "whatsapp_qr" || row.type === "whatsapp_official" ? row.type : null;
}

export type ChannelUsage = { sentToday: number; sentTimesLastHour: number[] };

/**
 * Envios de campanha do número hoje (fuso da empresa) e na última hora. Conta toda campanha do canal e os convites
 * de consentimento (`consents.invite_sent_at`): o teto de 50/dia é do NÚMERO (§5.7 item 2 e 7). Conta tentativas
 * (`attempted_at`), não só as aceitas, para uma falha no meio do dia não liberar volume extra.
 */
export async function channelUsage(tx: Transaction, channelId: string, now: Date, timeZone: string): Promise<ChannelUsage> {
  return (await channelUsageMany(tx, [channelId], now, timeZone)).get(channelId) ?? { sentToday: 0, sentTimesLastHour: [] };
}

/** Mesmo cálculo de `channelUsage` para vários canais de uma vez (duas consultas no total, não duas por canal). */
export async function channelUsageMany(tx: Transaction, channelIds: readonly string[], now: Date, timeZone: string): Promise<Map<string, ChannelUsage>> {
  const out = new Map<string, ChannelUsage>();
  if (channelIds.length === 0) return out;
  const dayStart = zonedToUtc(localDate(now, timeZone), "00:00", timeZone);
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const since = dayStart < hourAgo ? dayStart : hourAgo;
  const attempts = await tx
    .select({ channelId: campaigns.channelId, at: campaignRecipients.attemptedAt })
    .from(campaignRecipients)
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(and(inArray(campaigns.channelId, [...channelIds]), gte(campaignRecipients.attemptedAt, since)));
  const invites = await tx
    .select({ channelId: consents.channelId, at: consents.inviteSentAt })
    .from(consents)
    .where(and(inArray(consents.channelId, [...channelIds]), gte(consents.inviteSentAt, since)));
  const byChannel = new Map<string, Date[]>();
  for (const r of [...attempts, ...invites]) {
    if (!r.channelId || !r.at) continue;
    const list = byChannel.get(r.channelId) ?? [];
    list.push(r.at);
    byChannel.set(r.channelId, list);
  }
  for (const id of channelIds) {
    const times = byChannel.get(id) ?? [];
    out.set(id, {
      sentToday: times.filter((d) => d >= dayStart).length,
      sentTimesLastHour: times.filter((d) => d >= hourAgo).map((d) => d.getTime()),
    });
  }
  return out;
}

export function toSendingChannel(row: ChannelRow, usage: ChannelUsage, providers: ProviderRegistry | null, now: Date): CampaignChannel | null {
  const kind = channelKindOf(row);
  if (!kind) return null;
  const age = numberAgeDays(row.createdAt, now);
  const caps = providers?.get(row.provider)?.capabilities();
  return {
    id: row.id,
    name: row.name,
    kind,
    connected: row.status === "connected",
    numberAgeDays: age,
    dailyLimit: dailyLimitFor(kind, age),
    hourlyLimit: hourlyLimitFor(kind),
    sentToday: usage.sentToday,
    capabilities: {
      buttons: caps?.buttons ?? false,
      lists: caps?.lists ?? false,
      templates: caps?.templates ?? false,
      media: caps?.media ?? false,
    },
  };
}

export async function findChannelRow(tx: Transaction, organizationId: string, id: string | null | undefined): Promise<ChannelRow | undefined> {
  if (!id || !isUuid(id)) return undefined;
  const [row] = await tx.select().from(channels).where(and(eq(channels.id, id), eq(channels.organizationId, organizationId))).limit(1);
  return row && channelKindOf(row) ? row : undefined;
}

// ---------- público ----------

/**
 * Linhas do público (lista/segmento) já com a situação de consentimento e a flag de "conversou nos últimos 90 dias".
 * `null` = a lista não existe nesta empresa.
 */
export async function loadAudienceRows(
  tx: Transaction,
  organizationId: string,
  listId: string,
  recent: RecentContactsPort,
  now: Date,
): Promise<{ list: typeof contactLists.$inferSelect; rows: (AudienceRow & { name: string })[] } | null> {
  if (!isUuid(listId)) return null;
  const [list] = await tx.select().from(contactLists).where(and(eq(contactLists.id, listId), eq(contactLists.organizationId, organizationId))).limit(1);
  if (!list) return null;
  const found = await tx
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, createdAt: contacts.createdAt, consent: consents.status })
    .from(contacts)
    .leftJoin(consents, eq(consents.contactId, contacts.id))
    .where(and(eq(contacts.organizationId, organizationId), buildListCondition(list, now)));
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  const recentIds = await recent.recentContactIds(
    tx,
    organizationId,
    found.map((r) => r.id),
    since,
  );
  const rows = found.map((r) => ({
    contactId: r.id,
    name: r.name,
    phone: r.phone,
    createdAt: r.createdAt,
    consent: (r.consent === "granted" ? "granted" : r.consent === "denied" ? "denied" : "none") as ConsentKind,
    recent: recentIds.has(r.id),
  }));
  return { list, rows };
}

export async function audienceFor(tx: Transaction, organizationId: string, list: typeof contactLists.$inferSelect, recent: RecentContactsPort, now: Date): Promise<Audience> {
  const loaded = await loadAudienceRows(tx, organizationId, list.id, recent, now);
  const { breakdown } = classifyAudience(loaded?.rows ?? []);
  return { id: list.id, name: list.name, kind: list.kind === "segment" ? "segment" : "list", ...breakdown };
}

// ---------- campanhas → contrato ----------

export type CampaignStatsRow = { total: number; sent: number; delivered: number; failed: number; replied: number; optedOut: number; queued: number };

export async function statsFor(tx: Transaction, campaignIds: readonly string[]): Promise<Map<string, CampaignStatsRow>> {
  const out = new Map<string, CampaignStatsRow>();
  for (const ids of chunk([...campaignIds], 500)) {
    const rows = await tx
      .select({
        campaignId: campaignRecipients.campaignId,
        total: sql<number>`count(*) filter (where ${campaignRecipients.status} <> 'skipped')`.mapWith(Number),
        sent: sql<number>`count(*) filter (where ${campaignRecipients.sentAt} is not null)`.mapWith(Number),
        delivered: sql<number>`count(*) filter (where ${campaignRecipients.deliveredAt} is not null or ${campaignRecipients.readAt} is not null or ${campaignRecipients.repliedAt} is not null)`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'failed')`.mapWith(Number),
        replied: sql<number>`count(*) filter (where ${campaignRecipients.repliedAt} is not null)`.mapWith(Number),
        optedOut: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'opted_out')`.mapWith(Number),
        queued: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'queued' and ${campaignRecipients.attemptedAt} is null)`.mapWith(Number),
      })
      .from(campaignRecipients)
      .where(inArray(campaignRecipients.campaignId, ids))
      .groupBy(campaignRecipients.campaignId);
    for (const r of rows) out.set(r.campaignId, r);
  }
  return out;
}

const issueCodes = new Set<string>(["missing_variable", "missing_link", "missing_opt_out", "unknown_number_or_link", "too_similar", "too_different"]);

export function toVariationDto(row: VariationRow): MessageVariation {
  return {
    id: row.id,
    text: row.text,
    review: row.review === "approved" ? "approved" : row.review === "rejected" ? "rejected" : "pending",
    issues: row.issues.filter((i): i is VariationIssue => issueCodes.has(i)),
  };
}

/** Dias já enviados (por data local) + projeção do que falta. */
export type SentPerDay = { date: string; count: number }[];

/** Dias já enviados (por data local) de várias campanhas numa consulta só. */
export async function sentPerDayMany(tx: Transaction, campaignIds: readonly string[], timeZone: string): Promise<Map<string, SentPerDay>> {
  const out = new Map<string, SentPerDay>();
  if (campaignIds.length === 0) return out;
  const rows = await tx
    .select({
      campaignId: campaignRecipients.campaignId,
      day: sql<string>`to_char((${campaignRecipients.attemptedAt} at time zone ${timeZone})::date, 'YYYY-MM-DD')`,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(campaignRecipients)
    .where(and(inArray(campaignRecipients.campaignId, [...campaignIds]), sql`${campaignRecipients.attemptedAt} is not null`))
    .groupBy(campaignRecipients.campaignId, sql`2`)
    .orderBy(sql`2`);
  for (const r of rows) {
    const list = out.get(r.campaignId) ?? [];
    list.push({ date: r.day, count: r.n });
    out.set(r.campaignId, list);
  }
  return out;
}

async function sentPerDay(tx: Transaction, campaignId: string, timeZone: string): Promise<SentPerDay> {
  return (await sentPerDayMany(tx, [campaignId], timeZone)).get(campaignId) ?? [];
}

export type CampaignExtras = {
  stats: CampaignStatsRow;
  variations: VariationRow[];
  channel: { row: ChannelRow; usage: ChannelUsage } | null;
  /** Elegíveis do público (rascunho): vira `stats.total` e base do plano de dias. */
  eligibleNow: number | null;
};

export async function buildDayPlan(
  tx: Transaction,
  row: CampaignRow,
  extras: CampaignExtras,
  timeZone: string,
  now: Date,
  /** Já lido em lote pelo chamador (evita uma consulta por campanha). */
  pastByCampaign?: Map<string, SentPerDay>,
): Promise<{ date: string; count: number }[]> {
  const kind = extras.channel ? channelKindOf(extras.channel.row) : null;
  if (!kind || !extras.channel || kind !== "whatsapp_qr") return [];
  const window: SendWindow = { start: row.windowStart, end: row.windowEnd, skipSundaysAndHolidays: row.skipSundaysAndHolidays, timeZone };
  const remaining = row.status === "draft" ? (extras.eligibleNow ?? 0) : extras.stats.queued;
  const from = row.scheduleMode === "scheduled" && row.scheduledAt ? row.scheduledAt : now;
  const projected = projectDayPlan({
    count: remaining,
    kind,
    ageDays: numberAgeDays(extras.channel.row.createdAt, now),
    sentToday: extras.channel.usage.sentToday,
    from,
    now,
    window,
  });
  if (row.status === "draft") return projected;
  const past = pastByCampaign ? (pastByCampaign.get(row.id) ?? []) : await sentPerDay(tx, row.id, timeZone);
  const merged = new Map<string, number>();
  for (const d of [...past, ...projected]) merged.set(d.date, (merged.get(d.date) ?? 0) + d.count);
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

export function toCampaignDto(
  row: CampaignRow,
  extras: CampaignExtras,
  dayPlan: { date: string; count: number }[],
  providers: ProviderRegistry | null,
  now: Date,
): Campaign {
  const kind = extras.channel ? channelKindOf(extras.channel.row) : null;
  const total = row.status === "draft" ? (extras.eligibleNow ?? 0) : extras.stats.total;
  void providers;
  void now;
  return {
    id: row.id,
    name: row.name,
    status: row.status as Campaign["status"],
    audienceId: row.audienceId,
    audienceName: row.audienceName,
    message: {
      type: row.messageType as Campaign["message"]["type"],
      body: row.body,
      imageName: row.imageName,
      buttons: row.buttons,
      listButtonLabel: row.listButtonLabel,
      listItems: row.listItems,
      optOutLine: row.optOutLine,
      officialTemplateId: row.officialTemplateId,
    },
    variationMode: row.variationMode === "per_message" ? "per_message" : "bank",
    // API oficial: sem variação por IA
    variations: (row.channelKind ?? kind) === "whatsapp_official" ? [] : extras.variations.map(toVariationDto),
    variationsBase: row.variationsBase,
    sending: {
      channelId: row.channelId ?? "",
      scheduleMode: row.scheduleMode === "scheduled" ? "scheduled" : "now",
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      intervalMinSeconds: row.intervalMinSeconds,
      intervalMaxSeconds: row.intervalMaxSeconds,
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      skipSundaysAndHolidays: row.skipSundaysAndHolidays,
    },
    channelName: extras.channel?.row.name ?? row.channelName,
    channelKind: kind ?? (row.channelKind === "whatsapp_qr" || row.channelKind === "whatsapp_official" ? row.channelKind : null),
    stats: {
      total,
      sent: extras.stats.sent,
      delivered: extras.stats.delivered,
      failed: extras.stats.failed,
      replied: extras.stats.replied,
      optedOut: extras.stats.optedOut,
    },
    dayPlan,
    pauseReason: row.status === "paused" ? (row.pauseReason as Campaign["pauseReason"]) : null,
    pauseDetail: row.status === "paused" ? row.pauseDetail : null,
    nextSendAt: row.status === "sending" || row.status === "scheduled" ? (row.nextSendAt?.toISOString() ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toTemplateDto(row: TemplateRow): CampaignTemplate {
  return {
    id: row.id,
    name: row.name,
    type: row.type as CampaignTemplate["type"],
    body: row.body,
    buttons: row.buttons,
    source: row.source === "meta" ? "meta" : "internal",
    metaStatus: row.metaStatus === "approved" || row.metaStatus === "pending" || row.metaStatus === "rejected" ? row.metaStatus : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------- destinatários → contrato ----------

/** +5567998123456 → "+55 67 9••••-3456": o suficiente para reconhecer, sem expor o número inteiro na tela. */
export function maskPhone(phone: string | null) {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "••••";
  const last4 = digits.slice(-4);
  if (digits.startsWith("55") && digits.length >= 12) return `+55 ${digits.slice(2, 4)} ${digits.length === 13 ? "9" : ""}••••-${last4}`;
  return `+${digits.slice(0, 2)} ••••-${last4}`;
}

export function toRecipientDto(
  row: RecipientRow,
  extra: { campaignName: string; contactName: string | null; phone: string | null },
): CampaignRecipient | null {
  if (row.status === "skipped") return null;
  const at = row.status === "opted_out" ? (row.optedOutAt ?? row.sentAt ?? row.updatedAt) : (row.sentAt ?? row.attemptedAt ?? (row.status === "queued" ? null : row.updatedAt));
  return {
    id: row.id,
    campaignId: row.campaignId,
    campaignName: extra.campaignName,
    contactName: extra.contactName ?? "Contato removido",
    phoneMasked: maskPhone(extra.phone),
    status: row.status as CampaignRecipientStatus,
    variationNumber: row.variationNumber,
    intervalSeconds: row.intervalSeconds,
    at: at?.toISOString() ?? null,
  };
}

/**
 * Quantos contatos do público são elegíveis AGORA (opt-in concedido, com telefone, sem duplicata do 9º dígito): a mesma
 * regra de `classifyAudience(...).breakdown.optedIn`, mas com `count(distinct)` no banco em vez de carregar o público inteiro.
 */
export async function countEligibleAudience(tx: Transaction, organizationId: string, listId: string, now: Date): Promise<number> {
  if (!isUuid(listId)) return 0;
  const [list] = await tx.select().from(contactLists).where(and(eq(contactLists.id, listId), eq(contactLists.organizationId, organizationId))).limit(1);
  if (!list) return 0;
  const digits = sql`regexp_replace(${contacts.phone}, '[^0-9]', '', 'g')`;
  const key = sql`case when ${digits} ~ '^55[0-9]{2}9[0-9]{8}$' then substr(${digits}, 1, 4) || substr(${digits}, 6) else ${digits} end`;
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${key})`.mapWith(Number) })
    .from(contacts)
    .innerJoin(consents, eq(consents.contactId, contacts.id))
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        buildListCondition(list, now),
        eq(consents.status, "granted"),
        sql`${contacts.phone} is not null and ${contacts.phone} <> ''`,
      ),
    );
  return row?.n ?? 0;
}
