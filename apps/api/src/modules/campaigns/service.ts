import {
  type Audience,
  type Campaign,
  type CampaignChannel,
  type CampaignDraftInput,
  type CampaignRecipient,
  type CampaignTemplate,
  type CampaignTerms,
  type GenerateVariationsInput,
  type MessageVariation,
  validateVariation,
} from "@duckzap/contracts/campaigns";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { chunk, fail, newId, ok, type Result } from "../contacts/result";
import { classifyAudience, orderAudience } from "./engine/audience";
import { checkLaunch, type LaunchError } from "./engine/launch-rules";
import { isUuid, type CampaignCtx, type CampaignRow, type ChannelRow } from "./repo";
import {
  audienceFor,
  buildDayPlan,
  channelKindOf,
  channelUsage,
  channelUsageMany,
  countEligibleAudience,
  sentPerDayMany,
  findChannelRow,
  loadAudienceRows,
  loadOrgInfo,
  SENDING_CHANNEL_TYPES,
  statsFor,
  toCampaignDto,
  toRecipientDto,
  toSendingChannel,
  toTemplateDto,
  type CampaignExtras,
  type ChannelUsage,
} from "./repo";
import type { CampaignsRuntime } from "./ports";
import { generateVariationBank, toVariations } from "./variation-gen";
import { demoVariationTexts } from "./variation-demo";

const { campaigns, campaignRecipients, campaignVariations, campaignTemplates, campaignTermsAcceptance, channels, contactLists, contacts } = schema;

/** Versão vigente dos termos de campanhas. Subir esta string exige novo aceite (§5.4). */
export const CURRENT_TERMS_VERSION = "2026-10";

// ---------- leitura ----------

/** Teto da listagem (a tela mostra as mais recentes; evita hidratar centenas de campanhas de uma vez). */
const LIST_LIMIT = 200;

async function hydrate(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, rows: CampaignRow[], now: Date): Promise<Campaign[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const stats = await statsFor(tx, ids);
  const variationRows = await tx.select().from(campaignVariations).where(inArray(campaignVariations.campaignId, ids)).orderBy(asc(campaignVariations.position));
  const channelIds = [...new Set(rows.map((r) => r.channelId).filter((id): id is string => Boolean(id)))];
  const channelRows = channelIds.length ? await tx.select().from(channels).where(inArray(channels.id, channelIds)) : [];
  const usageByChannel = await channelUsageMany(
    tx,
    channelRows.map((c) => c.id),
    now,
    ctx.timeZone,
  );

  // rascunhos: o total é o público elegível AGORA (uma consulta por lista distinta)
  const eligibleByAudience = new Map<string, number>();
  for (const audienceId of new Set(rows.filter((r) => r.status === "draft" && r.audienceId).map((r) => r.audienceId as string))) {
    eligibleByAudience.set(audienceId, await countEligibleAudience(tx, ctx.organizationId, audienceId, now));
  }
  const planned = rows.filter((r) => r.status === "scheduled" || r.status === "sending" || r.status === "paused").map((r) => r.id);
  const pastByCampaign = await sentPerDayMany(tx, planned, ctx.timeZone);

  const empty = { total: 0, sent: 0, delivered: 0, failed: 0, replied: 0, optedOut: 0, queued: 0 };
  const out: Campaign[] = [];
  for (const row of rows) {
    const channelRow = row.channelId ? channelRows.find((c) => c.id === row.channelId) : undefined;
    const extras: CampaignExtras = {
      stats: stats.get(row.id) ?? empty,
      variations: variationRows.filter((v) => v.campaignId === row.id),
      channel: channelRow ? { row: channelRow, usage: usageByChannel.get(channelRow.id) ?? { sentToday: 0, sentTimesLastHour: [] } } : null,
      eligibleNow: row.audienceId ? (eligibleByAudience.get(row.audienceId) ?? 0) : 0,
    };
    const dayPlan = row.status === "draft" || row.status === "scheduled" || row.status === "sending" || row.status === "paused" ? await buildDayPlan(tx, row, extras, ctx.timeZone, now, pastByCampaign) : [];
    out.push(toCampaignDto(row, extras, dayPlan, rt.channels.providers, now));
  }
  return out;
}

export async function listCampaigns(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, now = rt.now()): Promise<Campaign[]> {
  const rows = await tx.select().from(campaigns).where(eq(campaigns.organizationId, ctx.organizationId)).orderBy(desc(campaigns.updatedAt)).limit(LIST_LIMIT);
  return hydrate(tx, ctx, rt, rows, now);
}

export async function getCampaign(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, id: string, now = rt.now()): Promise<Campaign | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId))).limit(1);
  if (!row) return null;
  return (await hydrate(tx, ctx, rt, [row], now))[0] ?? null;
}

/** Campanhas encerradas (concluídas e canceladas), da mais recente para a mais antiga. */
export async function listHistory(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, now = rt.now()): Promise<Campaign[]> {
  const rows = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.organizationId, ctx.organizationId), inArray(campaigns.status, ["completed", "canceled"])))
    .orderBy(sql`${campaigns.finishedAt} desc nulls last`, desc(campaigns.updatedAt))
    .limit(LIST_LIMIT);
  return hydrate(tx, ctx, rt, rows, now);
}

const RECIPIENT_LIMIT = 5000;

async function recipientsOf(
  tx: Transaction,
  ctx: CampaignCtx,
  where: ReturnType<typeof and>,
  order: ReturnType<typeof sql>[],
): Promise<CampaignRecipient[]> {
  const rows = await tx
    .select({ r: campaignRecipients, campaignName: campaigns.name, contactName: contacts.name, phone: contacts.phone })
    .from(campaignRecipients)
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .leftJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(and(eq(campaignRecipients.organizationId, ctx.organizationId), where))
    .orderBy(...order)
    .limit(RECIPIENT_LIMIT);
  return rows.flatMap((x) => {
    const dto = toRecipientDto(x.r, { campaignName: x.campaignName, contactName: x.contactName, phone: x.phone });
    return dto ? [dto] : [];
  });
}

export async function listRecipients(tx: Transaction, ctx: CampaignCtx, campaignId: string): Promise<Result<CampaignRecipient[], "not_found">> {
  if (!isUuid(campaignId)) return fail("not_found", "Campanha não encontrada.");
  const [row] = await tx.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.id, campaignId), eq(campaigns.organizationId, ctx.organizationId))).limit(1);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  return ok(await recipientsOf(tx, ctx, eq(campaignRecipients.campaignId, campaignId), [sql`${campaignRecipients.sentAt} desc nulls last`, sql`${campaignRecipients.position} asc`]));
}

/** Rejeitados: opt-out, sem WhatsApp e falha. Sem `campaignId`, de todas as campanhas. */
export async function listRejected(tx: Transaction, ctx: CampaignCtx, campaignId?: string): Promise<CampaignRecipient[]> {
  if (campaignId !== undefined && !isUuid(campaignId)) return [];
  return recipientsOf(
    tx,
    ctx,
    and(inArray(campaignRecipients.status, ["opted_out", "no_whatsapp", "failed"]), campaignId ? eq(campaignRecipients.campaignId, campaignId) : undefined),
    [sql`coalesce(${campaignRecipients.optedOutAt}, ${campaignRecipients.attemptedAt}, ${campaignRecipients.updatedAt}) desc`],
  );
}

export async function listAudiences(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, now = rt.now()): Promise<Audience[]> {
  const lists = await tx.select().from(contactLists).where(eq(contactLists.organizationId, ctx.organizationId)).orderBy(asc(contactLists.name));
  const out: Audience[] = [];
  for (const list of lists) out.push(await audienceFor(tx, ctx.organizationId, list, rt.ports.recent, now));
  return out;
}

export async function listSendingChannels(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, now = rt.now()): Promise<CampaignChannel[]> {
  const rows = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, ctx.organizationId), inArray(channels.type, [...SENDING_CHANNEL_TYPES])))
    .orderBy(desc(channels.isDefault), asc(channels.name));
  const out: CampaignChannel[] = [];
  for (const row of rows) {
    const dto = toSendingChannel(row, await channelUsage(tx, row.id, now, ctx.timeZone), rt.channels.providers, now);
    if (dto) out.push(dto);
  }
  return out;
}

// ---------- modelos ----------

export async function listTemplates(tx: Transaction, ctx: CampaignCtx): Promise<CampaignTemplate[]> {
  const rows = await tx.select().from(campaignTemplates).where(eq(campaignTemplates.organizationId, ctx.organizationId)).orderBy(desc(campaignTemplates.updatedAt));
  return rows.map(toTemplateDto);
}

export async function saveTemplate(
  tx: Transaction,
  ctx: CampaignCtx,
  input: Pick<CampaignTemplate, "name" | "type" | "body" | "buttons">,
  now = new Date(),
): Promise<Result<CampaignTemplate>> {
  const [row] = await tx
    .insert(campaignTemplates)
    .values({ id: newId(), organizationId: ctx.organizationId, name: input.name, type: input.type, body: input.body, buttons: input.buttons, source: "internal", createdBy: ctx.userId, createdAt: now, updatedAt: now })
    .returning();
  if (!row) throw new Error("modelo não gravado");
  return ok(toTemplateDto(row));
}

export async function deleteTemplate(tx: Transaction, ctx: CampaignCtx, id: string): Promise<Result<null, "not_found" | "read_only">> {
  if (!isUuid(id)) return fail("not_found", "Modelo não encontrado.");
  const [row] = await tx.select().from(campaignTemplates).where(and(eq(campaignTemplates.id, id), eq(campaignTemplates.organizationId, ctx.organizationId))).limit(1);
  if (!row) return fail("not_found", "Modelo não encontrado.");
  if (row.source === "meta") return fail("read_only", "Modelos da Meta são gerenciados no WhatsApp Manager.");
  await tx.delete(campaignTemplates).where(eq(campaignTemplates.id, id));
  return ok(null);
}

// ---------- termos ----------

export async function getTerms(tx: Transaction, ctx: CampaignCtx): Promise<CampaignTerms> {
  const [row] = await tx
    .select()
    .from(campaignTermsAcceptance)
    .where(and(eq(campaignTermsAcceptance.organizationId, ctx.organizationId), eq(campaignTermsAcceptance.version, CURRENT_TERMS_VERSION)))
    .limit(1);
  return row
    ? { accepted: true, acceptedAt: row.acceptedAt.toISOString(), acceptedBy: row.userName, version: CURRENT_TERMS_VERSION }
    : { accepted: false, acceptedAt: null, acceptedBy: null, version: CURRENT_TERMS_VERSION };
}

/** Quem aceita é a pessoa da sessão (o nome vem do servidor, nunca do corpo). Idempotente: o primeiro aceite vale. */
export async function acceptTerms(tx: Transaction, ctx: CampaignCtx, now = new Date()): Promise<CampaignTerms> {
  await tx
    .insert(campaignTermsAcceptance)
    .values({ id: newId(), organizationId: ctx.organizationId, userId: ctx.userId, userName: ctx.userName, version: CURRENT_TERMS_VERSION, acceptedAt: now })
    .onConflictDoNothing();
  return getTerms(tx, ctx);
}

// ---------- rascunhos ----------

type DraftFields = {
  channel: ChannelRow | undefined;
  values: Partial<typeof campaigns.$inferInsert>;
  variations: { id: string; text: string; review: "pending" | "approved" | "rejected"; issues: string[]; edited: boolean }[];
};

async function normalizeDraft(tx: Transaction, ctx: CampaignCtx, input: CampaignDraftInput, existing: (typeof campaignVariations.$inferSelect)[]): Promise<DraftFields> {
  const channel = await findChannelRow(tx, ctx.organizationId, input.sending.channelId);
  let audience: typeof contactLists.$inferSelect | undefined;
  if (input.audienceId && isUuid(input.audienceId)) {
    [audience] = await tx.select().from(contactLists).where(and(eq(contactLists.id, input.audienceId), eq(contactLists.organizationId, ctx.organizationId))).limit(1);
  }
  let templateId: string | null = null;
  if (input.message.officialTemplateId && isUuid(input.message.officialTemplateId)) {
    const [tpl] = await tx.select({ id: campaignTemplates.id }).from(campaignTemplates).where(and(eq(campaignTemplates.id, input.message.officialTemplateId), eq(campaignTemplates.organizationId, ctx.organizationId))).limit(1);
    templateId = tpl?.id ?? null;
  }
  const kind = channel ? channelKindOf(channel) : null;
  const s = input.sending;
  const base = input.variationsBase ?? input.message.body;
  const known = new Map(existing.map((v) => [v.id, v]));
  const used = new Set<string>();
  const texts = input.variations.map((v) => v.text);
  const variations =
    kind === "whatsapp_official"
      ? []
      : input.variations.map((v, i) => {
          const prior = isUuid(v.id) ? known.get(v.id) : undefined;
          const id = prior && !used.has(prior.id) ? prior.id : newId();
          used.add(id);
          return {
            id,
            text: v.text,
            review: v.review,
            // problemas SEMPRE recalculados aqui: o que o navegador manda não vale como validação
            issues: validateVariation(base, input.message.optOutLine, v.text, texts.filter((_, j) => j !== i)),
            edited: Boolean(prior && (prior.edited || prior.text !== v.text)),
          };
        });
  return {
    channel,
    values: {
      name: input.name,
      audienceId: audience?.id ?? null,
      audienceName: audience?.name ?? null,
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? null,
      channelKind: kind,
      messageType: input.message.type,
      body: input.message.body,
      imageName: input.message.imageName,
      buttons: input.message.buttons,
      listButtonLabel: input.message.listButtonLabel,
      listItems: input.message.listItems,
      optOutLine: input.message.optOutLine,
      officialTemplateId: templateId,
      variationMode: input.variationMode,
      variationsBase: input.variationsBase,
      scheduleMode: s.scheduleMode,
      scheduledAt: s.scheduleMode === "scheduled" && s.scheduledAt ? new Date(s.scheduledAt) : null,
      intervalMinSeconds: s.intervalMinSeconds,
      intervalMaxSeconds: s.intervalMaxSeconds,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      skipSundaysAndHolidays: s.skipSundaysAndHolidays,
    },
    variations,
  };
}

async function replaceVariations(tx: Transaction, ctx: CampaignCtx, campaignId: string, variations: DraftFields["variations"]) {
  await tx.delete(campaignVariations).where(eq(campaignVariations.campaignId, campaignId));
  for (const part of chunk(variations, 100)) {
    if (!part.length) continue;
    await tx.insert(campaignVariations).values(
      part.map((v) => ({
        id: v.id,
        organizationId: ctx.organizationId,
        campaignId,
        position: variations.indexOf(v),
        text: v.text,
        review: v.review,
        edited: v.edited,
        issues: v.issues,
      })),
    );
  }
}

export async function createDraft(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, input: CampaignDraftInput, now = rt.now()): Promise<Result<Campaign>> {
  const fields = await normalizeDraft(tx, ctx, input, []);
  const id = newId();
  await tx.insert(campaigns).values({
    ...fields.values,
    id,
    organizationId: ctx.organizationId,
    name: input.name,
    status: "draft",
    messageType: input.message.type,
    optOutLine: input.message.optOutLine,
    createdBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
  });
  await replaceVariations(tx, ctx, id, fields.variations);
  const dto = await getCampaign(tx, ctx, rt, id, now);
  if (!dto) throw new Error("campanha não gravada");
  return ok(dto);
}

export async function updateDraft(
  tx: Transaction,
  ctx: CampaignCtx,
  rt: CampaignsRuntime,
  id: string,
  input: CampaignDraftInput,
  now = rt.now(),
): Promise<Result<Campaign, "not_found" | "not_draft">> {
  const row = await lockCampaign(tx, ctx, id);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  if (row.status !== "draft") return fail("not_draft", "Só dá para editar campanhas em rascunho.");
  const existing = await tx.select().from(campaignVariations).where(eq(campaignVariations.campaignId, id));
  const fields = await normalizeDraft(tx, ctx, input, existing);
  await tx
    .update(campaigns)
    .set({ ...fields.values, updatedAt: now })
    .where(eq(campaigns.id, id));
  await replaceVariations(tx, ctx, id, fields.variations);
  const dto = await getCampaign(tx, ctx, rt, id, now);
  if (!dto) throw new Error("campanha não encontrada");
  return ok(dto);
}

export async function deleteDraft(tx: Transaction, ctx: CampaignCtx, id: string): Promise<Result<null, "not_found" | "not_draft">> {
  const row = await lockCampaign(tx, ctx, id);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  if (row.status !== "draft") return fail("not_draft", "Só rascunhos podem ser excluídos.");
  await tx.delete(campaigns).where(eq(campaigns.id, id));
  return ok(null);
}

export async function duplicateCampaign(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, id: string, now = rt.now()): Promise<Result<Campaign, "not_found">> {
  if (!isUuid(id)) return fail("not_found", "Campanha não encontrada.");
  const [row] = await tx.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId))).limit(1);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  const copyId = newId();
  const { engineState: _engineState, ...rest } = row;
  void _engineState;
  await tx.insert(campaigns).values({
    ...rest,
    id: copyId,
    name: `${row.name} (cópia)`.slice(0, 80),
    status: "draft",
    scheduleMode: "now",
    scheduledAt: null,
    audienceSnapshot: null,
    recipientsTotal: 0,
    pauseReason: null,
    pauseDetail: null,
    nextSendAt: null,
    createdBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  });
  const variations = await tx.select().from(campaignVariations).where(eq(campaignVariations.campaignId, id)).orderBy(asc(campaignVariations.position));
  await replaceVariations(
    tx,
    ctx,
    copyId,
    variations.map((v) => ({ id: newId(), text: v.text, review: v.review as "pending" | "approved" | "rejected", issues: v.issues, edited: v.edited })),
  );
  const dto = await getCampaign(tx, ctx, rt, copyId, now);
  if (!dto) throw new Error("cópia não gravada");
  return ok(dto);
}

async function lockCampaign(tx: Transaction, ctx: CampaignCtx, id: string): Promise<CampaignRow | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.organizationId, ctx.organizationId)))
    .for("update")
    .limit(1);
  return row;
}

// ---------- variações por IA ----------

export async function generateVariations(
  rt: CampaignsRuntime,
  ctx: Pick<CampaignCtx, "organizationId">,
  input: GenerateVariationsInput,
): Promise<Result<MessageVariation[], "generation_failed">> {
  const base = input.base.trim();
  // sem provedor de IA configurado (fake): gerador de demonstração por regras, para a tela funcionar
  if (rt.llm.name === "fake") return ok(toVariations(base, input.optOutLine, demoVariationTexts(input)));
  const result = await generateVariationBank({ llm: rt.llm, organizationId: ctx.organizationId }, { ...input, base });
  return result.ok ? ok(result.variations) : fail("generation_failed", result.message);
}

// ---------- ciclo de vida ----------

export type LifecycleError = "not_found" | "invalid_state" | "channel_unavailable";

export async function pauseCampaign(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, id: string, now = rt.now()): Promise<Result<Campaign, LifecycleError>> {
  const row = await lockCampaign(tx, ctx, id);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  if (row.status !== "sending" && row.status !== "scheduled") return fail("invalid_state", "Esta ação não vale para o status atual da campanha.");
  await tx.update(campaigns).set({ status: "paused", pauseReason: "manual", pauseDetail: null, nextSendAt: null, updatedAt: now }).where(eq(campaigns.id, id));
  return reload(tx, ctx, rt, id, now);
}

/** Retomar é sempre manual, inclusive depois da parada automática (§5.7 item 5). O disjuntor só olha envios feitos DEPOIS da retomada. */
export async function resumeCampaign(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, id: string, now = rt.now()): Promise<Result<Campaign, LifecycleError>> {
  const row = await lockCampaign(tx, ctx, id);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  if (row.status !== "paused") return fail("invalid_state", "Esta ação não vale para o status atual da campanha.");
  const channel = await findChannelRow(tx, ctx.organizationId, row.channelId);
  if (!channel || channel.status !== "connected") return fail("channel_unavailable", "O canal está desconectado. Reconecte antes de retomar.");
  const notStarted = !row.startedAt && row.scheduledAt && row.scheduledAt.getTime() > now.getTime();
  await tx
    .update(campaigns)
    .set({
      status: notStarted ? "scheduled" : "sending",
      pauseReason: null,
      pauseDetail: null,
      nextSendAt: notStarted ? row.scheduledAt : new Date(now.getTime() + row.intervalMinSeconds * 1000),
      engineState: { ...row.engineState, breakerSince: now.toISOString() },
      startedAt: row.startedAt ?? (notStarted ? null : now),
      updatedAt: now,
    })
    .where(eq(campaigns.id, id));
  return reload(tx, ctx, rt, id, now);
}

export async function cancelCampaign(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, id: string, now = rt.now()): Promise<Result<Campaign, LifecycleError>> {
  const row = await lockCampaign(tx, ctx, id);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  if (row.status !== "sending" && row.status !== "scheduled" && row.status !== "paused") return fail("invalid_state", "Esta ação não vale para o status atual da campanha.");
  await tx.update(campaigns).set({ status: "canceled", nextSendAt: null, finishedAt: now, updatedAt: now }).where(eq(campaigns.id, id));
  return reload(tx, ctx, rt, id, now);
}

async function reload(tx: Transaction, ctx: CampaignCtx, rt: CampaignsRuntime, id: string, now: Date): Promise<Result<Campaign, never>> {
  const dto = await getCampaign(tx, ctx, rt, id, now);
  if (!dto) throw new Error("campanha não encontrada");
  return ok(dto);
}

// ---------- disparo ----------

/**
 * Dispara: confere TUDO no servidor (termos, público, canal, variações, modelo), congela o público em
 * `campaign_recipients` (sem opt-in, sem opt-out, sem duplicados, sem número inexistente; embaralhado e priorizando
 * os últimos 90 dias) e deixa a campanha `sending` (ou `scheduled`). Quem envia é o motor (`runCampaignTick`).
 */
export async function launchCampaign(
  tx: Transaction,
  ctx: CampaignCtx,
  rt: CampaignsRuntime,
  id: string,
  now = rt.now(),
): Promise<Result<Campaign, LaunchError>> {
  const row = await lockCampaign(tx, ctx, id);
  if (!row) return fail("not_found", "Campanha não encontrada.");
  const terms = await getTerms(tx, ctx);
  const channel = await findChannelRow(tx, ctx.organizationId, row.channelId);
  const kind = channel ? channelKindOf(channel) : null;
  const variations = await tx.select().from(campaignVariations).where(eq(campaignVariations.campaignId, id)).orderBy(asc(campaignVariations.position));
  let template: typeof campaignTemplates.$inferSelect | undefined;
  if (row.officialTemplateId) {
    [template] = await tx.select().from(campaignTemplates).where(eq(campaignTemplates.id, row.officialTemplateId)).limit(1);
  }
  const loaded = row.audienceId ? await loadAudienceRows(tx, ctx.organizationId, row.audienceId, rt.ports.recent, now) : null;
  const classified = classifyAudience(loaded?.rows ?? []);

  // número sem WhatsApp (checagem prévia no provedor, quando houver): sai do envio e vai para "Rejeitados"
  let noWhatsapp = new Set<string>();
  if (channel && classified.eligible.length) {
    const phones = classified.eligible.map((r) => r.phone as string);
    const result = await rt.ports.whatsappCheck.check({ organizationId: ctx.organizationId, channelId: channel.id }, phones);
    noWhatsapp = new Set(phones.filter((p) => result.get(p) === false));
  }
  const sendable = classified.eligible.filter((r) => !noWhatsapp.has(r.phone as string));

  const verdict = checkLaunch({
    status: row.status as Campaign["status"],
    termsAccepted: terms.accepted,
    audienceId: row.audienceId,
    eligibleRecipients: sendable.length,
    channel: channel && kind ? { connected: channel.status === "connected", kind } : null,
    message: { body: row.body, optOutLine: row.optOutLine, type: row.messageType },
    template: template ? { metaStatus: template.metaStatus, body: template.body } : null,
    variationsBase: row.variationsBase,
    variations: variations.map((v) => ({ review: v.review, issues: v.issues })),
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    scheduleMode: row.scheduleMode === "scheduled" ? "scheduled" : "now",
    scheduledAt: row.scheduledAt,
    now,
  });
  if (!verdict.ok) return fail(verdict.error, verdict.message);
  if (!channel || !kind) return fail("channel_unavailable", "O canal escolhido está desconectado. Reconecte ou escolha outro.");

  const ordered = orderAudience(sendable, rt.rng);
  const removed = classified.eligible.filter((r) => noWhatsapp.has(r.phone as string));
  const rows = [
    ...ordered.map((r, position) => ({ r, position, status: "queued" as const })),
    ...removed.map((r, i) => ({ r, position: ordered.length + i, status: "no_whatsapp" as const })),
  ];
  for (const part of chunk(rows, 500)) {
    await tx.insert(campaignRecipients).values(
      part.map(({ r, position, status }) => {
        const recipientId = newId();
        return {
          id: recipientId,
          organizationId: ctx.organizationId,
          campaignId: id,
          contactId: r.contactId,
          position,
          status,
          reason: status === "no_whatsapp" ? "Número sem WhatsApp (checagem prévia)" : null,
          // determinístico por destinatário: reenviar o mesmo job nunca duplica no provedor (sendViaChannel é idempotente)
          externalId: `cmp-${recipientId}`,
          createdAt: now,
          updatedAt: now,
        };
      }),
    );
  }

  const scheduled = row.scheduleMode === "scheduled" && row.scheduledAt && row.scheduledAt.getTime() > now.getTime();
  await tx
    .update(campaigns)
    .set({
      status: scheduled ? "scheduled" : "sending",
      startedAt: scheduled ? null : now,
      nextSendAt: scheduled ? row.scheduledAt : now,
      channelName: channel.name,
      channelKind: kind,
      audienceName: loaded?.list.name ?? row.audienceName,
      audienceSnapshot: { ...classified.breakdown, noWhatsapp: noWhatsapp.size },
      recipientsTotal: rows.length,
      pauseReason: null,
      pauseDetail: null,
      engineState: { breakerSince: now.toISOString() },
      updatedAt: now,
    })
    .where(eq(campaigns.id, id));
  return reload(tx, ctx, rt, id, now);
}

export { loadOrgInfo };
