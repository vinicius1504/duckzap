import {
  conversationModeSchema,
  conversationPrioritySchema,
  conversationStatusSchema,
  messageStatusSchema,
  type ContactProfile,
  type ConversationDetail,
  type ConversationList,
  type ConversationSummary,
  type InboxFilters,
  type InboxLookups,
  type InboxTab,
  type Message,
} from "@duckzap/contracts/conversations";
import { agentConfigSchema } from "@duckzap/contracts/agents";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, desc, eq, exists, inArray, isNull, ne, or, sql, count, type SQL } from "drizzle-orm";
import { z } from "zod";
import { effectiveConsentStatus } from "../contacts/consent";
import { ensureDefaultTags } from "../contacts/service";
import { isGuid } from "../contacts/http";
import { newId, type ServiceCtx } from "../contacts/result";
import { signMessageMedia, type SignedMedia } from "../media/service";
import { OPEN_STATUSES, isVisibleTo, lastMessageKindOf, likePattern, type Viewer } from "./logic";

const { conversations, messages, contacts, contactTags, tags, channels, teams, teamMembers, agents, agentVersions, member, user, memberProfiles, quickReplies } = schema;

export type ConvCtx = ServiceCtx & { canViewAll: boolean; sendingPaused: boolean };
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

const iso = (d: Date) => d.toISOString();
const MAX_LIST_ITEMS = 200;
const MAX_THREAD_MESSAGES = 300;
const MAX_HISTORY_ITEMS = 8;

// ── quem está vendo ─────────────────────────────────────────────────────────

export async function loadViewer(tx: Transaction, ctx: ConvCtx): Promise<Viewer> {
  const rows = await tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.organizationId, ctx.organizationId), eq(teamMembers.memberRef, ctx.userId)));
  return { id: ctx.userId, canViewAll: ctx.canViewAll, teamIds: new Set(rows.map((r) => r.teamId)) };
}

/** Espelho SQL de `isVisibleTo` (logic.ts). `undefined` = sem restrição. */
export function visibilitySql(viewer: Viewer): SQL | undefined {
  if (viewer.canViewAll) return undefined;
  const team = viewer.teamIds.size ? inArray(conversations.teamId, [...viewer.teamIds]) : sql`false`;
  return or(
    eq(conversations.assigneeId, viewer.id),
    and(
      isNull(conversations.assigneeId),
      ne(conversations.status, "resolved"),
      // fila de uma equipe é só dela; só a fila sem equipe é de todos
      or(team, and(isNull(conversations.teamId), eq(conversations.status, "handoff_requested"))),
    ),
  );
}

export function tabSql(tab: InboxTab, viewer: Viewer): SQL {
  switch (tab) {
    case "mine":
      return sql`(${inArray(conversations.status, [...OPEN_STATUSES])} and ${eq(conversations.assigneeId, viewer.id)})`;
    case "waiting":
      return sql`${eq(conversations.status, "handoff_requested")}`;
    case "ai":
      return sql`${eq(conversations.status, "ai_active")}`;
    case "all":
      return viewer.canViewAll ? sql`${inArray(conversations.status, [...OPEN_STATUSES])}` : sql`false`;
    case "resolved":
      return sql`${eq(conversations.status, "resolved")}`;
  }
}

// ── etiquetas / funil ───────────────────────────────────────────────────────

type TagRow = { id: string; name: string; funnelStage: number | null };

/** Etiquetas da empresa (cria as 4 etapas do funil se ainda não existem). */
export async function loadTags(tx: Transaction, ctx: Pick<ServiceCtx, "organizationId">): Promise<TagRow[]> {
  await ensureDefaultTags(tx, ctx.organizationId);
  return tx
    .select({ id: tags.id, name: tags.name, funnelStage: tags.funnelStage })
    .from(tags)
    .where(eq(tags.organizationId, ctx.organizationId))
    .orderBy(asc(tags.position));
}

export function firstStageTag(all: readonly TagRow[]): TagRow | undefined {
  return all.filter((t) => t.funnelStage !== null).sort((a, b) => (a.funnelStage ?? 0) - (b.funnelStage ?? 0))[0];
}

type ContactTagInfo = { stageId: string | null; tagIds: string[] };

async function contactTagInfo(tx: Transaction, contactIds: string[]): Promise<Map<string, ContactTagInfo>> {
  const out = new Map<string, ContactTagInfo>();
  if (contactIds.length === 0) return out;
  const rows = await tx
    .select({ contactId: contactTags.contactId, tagId: tags.id, funnelStage: tags.funnelStage })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(inArray(contactTags.contactId, contactIds));
  const stages = new Map<string, { id: string; stage: number }>();
  for (const r of rows) {
    const info = out.get(r.contactId) ?? { stageId: null, tagIds: [] };
    if (r.funnelStage === null) info.tagIds.push(r.tagId);
    else {
      const best = stages.get(r.contactId);
      if (!best || r.funnelStage > best.stage) stages.set(r.contactId, { id: r.tagId, stage: r.funnelStage });
    }
    out.set(r.contactId, info);
  }
  for (const [contactId, best] of stages) {
    const info = out.get(contactId);
    if (info) info.stageId = best.id;
  }
  return out;
}

export const statusOf = (row: Pick<ConversationRow, "status">) => conversationStatusSchema.catch("human_active").parse(row.status);
export const modeOf = (row: Pick<ConversationRow, "mode">) => conversationModeSchema.catch("human").parse(row.mode);

// ── mapeamento linha → contrato ─────────────────────────────────────────────

type ContactBrief = { id: string; name: string; phone: string | null; instagram: string | null };

function toSummary(row: ConversationRow, contact: ContactBrief, info: ContactTagInfo | undefined, defaultStageId: string): ConversationSummary {
  return {
    id: row.id,
    contact: { id: contact.id, name: contact.name, phone: contact.phone, handle: contact.instagram },
    channelId: row.channelId,
    teamId: row.teamId,
    assigneeId: row.assigneeId,
    agentId: row.agentId,
    status: conversationStatusSchema.catch("human_active").parse(row.status),
    mode: conversationModeSchema.catch("human").parse(row.mode),
    priority: conversationPrioritySchema.catch("normal").parse(row.priority),
    stageId: info?.stageId ?? defaultStageId,
    tagIds: info?.tagIds ?? [],
    resolvedBy: row.resolvedBy === "ai" || row.resolvedBy === "human" ? row.resolvedBy : null,
    lastMessage: {
      preview: row.lastMessagePreview,
      kind: lastMessageKindOf(row.lastMessageKind),
      fileName: row.lastMessageFileName,
      durationSeconds: row.lastMessageDurationSeconds,
      at: iso(row.lastMessageAt),
      direction: row.lastMessageDirection === "out" ? "out" : "in",
    },
    unreadCount: row.unreadCount,
    waitingSince: row.waitingSince ? iso(row.waitingSince) : null,
    followUp: row.followUpAt ? { scheduledAt: iso(row.followUpAt), paused: row.followUpPaused, agentId: row.agentId ?? "" } : null,
  };
}

export const mediaSchema = z.object({
  fileName: z.string().nullable().catch(null),
  mimeType: z.string().catch("application/octet-stream"),
  sizeBytes: z.number().int().nullable().catch(null),
  durationSeconds: z.number().int().nullable().catch(null),
  url: z.string().nullable().catch(null),
  mediaId: z.string().nullable().catch(null),
  sticker: z.boolean().optional().catch(undefined),
});

/**
 * Linha → contrato. A URL do anexo NUNCA vem do JSON gravado (referência crua do provedor ou texto do cliente): só de `signed`,
 * a URL assinada curta do arquivo guardado (`signMessageMedia`). Sem `signed` (sem armazenamento, arquivo apagado) é null.
 */
export function toMessage(row: MessageRow, contactName: string, signed?: SignedMedia): Message {
  const kind = z.enum(["text", "audio", "image", "document", "note", "event"]).catch("text").parse(row.kind);
  const direction = row.direction === "out" ? "out" : row.direction === "in" ? "in" : "internal";
  const media = row.media ? mediaSchema.safeParse(row.media) : null;
  const author =
    row.senderKind === "contact"
      ? { kind: "contact" as const, id: null, name: contactName }
      : row.senderKind === "member"
        ? { kind: "member" as const, id: row.senderId, name: row.senderName }
        : row.senderKind === "agent"
          ? { kind: "agent" as const, id: row.senderId, name: row.senderName }
          : { kind: "system" as const, id: null, name: row.senderName || "Duckzap" };
  return {
    id: row.id,
    conversationId: row.conversationId,
    kind,
    direction,
    author,
    body: row.body,
    attachment: media?.success ? { ...media.data, url: signed?.url ?? null, thumbnailUrl: signed?.thumbnailUrl ?? null, mediaId: signed?.mediaId ?? media.data.mediaId } : null,
    status: direction === "out" ? messageStatusSchema.catch("sent").parse(row.status) : null,
    failureReason: row.error,
    createdAt: iso(row.createdAt),
  };
}

// ── leituras ────────────────────────────────────────────────────────────────

async function summariesFor(tx: Transaction, ctx: ServiceCtx, rows: { c: ConversationRow; contact: ContactBrief }[]): Promise<ConversationSummary[]> {
  const info = await contactTagInfo(tx, [...new Set(rows.map((r) => r.contact.id))]);
  const stage1 = firstStageTag(await loadTags(tx, ctx));
  return rows.map((r) => toSummary(r.c, r.contact, info.get(r.contact.id), stage1?.id ?? ""));
}

const contactBrief = { id: contacts.id, name: contacts.name, phone: contacts.phone, instagram: contacts.instagram };

export async function listConversations(tx: Transaction, ctx: ConvCtx, filters: InboxFilters): Promise<ConversationList> {
  const viewer = await loadViewer(tx, ctx);
  const empty: ConversationList = { items: [], counts: { mine: 0, waiting: 0, ai: 0, all: 0, resolved: 0 } };
  for (const id of [filters.channelId, filters.teamId, filters.tagId]) if (id && !isGuid(id)) return empty;

  const search = filters.search?.trim();
  const base: (SQL | undefined)[] = [
    eq(conversations.organizationId, ctx.organizationId),
    visibilitySql(viewer),
    filters.channelId ? eq(conversations.channelId, filters.channelId) : undefined,
    filters.teamId ? eq(conversations.teamId, filters.teamId) : undefined,
    filters.priority ? eq(conversations.priority, filters.priority) : undefined,
    filters.tagId
      ? exists(
          tx
            .select({ one: sql`1` })
            .from(contactTags)
            .where(and(eq(contactTags.contactId, conversations.contactId), eq(contactTags.tagId, filters.tagId))),
        )
      : undefined,
    search
      ? or(
          sql`${contacts.name} ilike ${likePattern(search)}`,
          sql`coalesce(${contacts.phone}, '') ilike ${likePattern(search)}`,
          sql`coalesce(${contacts.instagram}, '') ilike ${likePattern(search)}`,
          exists(
            tx
              .select({ one: sql`1` })
              .from(messages)
              .where(and(eq(messages.conversationId, conversations.id), ne(messages.kind, "event"), sql`${messages.body} ilike ${likePattern(search)}`)),
          ),
        )
      : undefined,
  ];

  const countRows = await tx
    .select({
      mine: sql<number>`count(*) filter (where ${tabSql("mine", viewer)})::int`,
      waiting: sql<number>`count(*) filter (where ${tabSql("waiting", viewer)})::int`,
      ai: sql<number>`count(*) filter (where ${tabSql("ai", viewer)})::int`,
      all: sql<number>`count(*) filter (where ${tabSql("all", viewer)})::int`,
      resolved: sql<number>`count(*) filter (where ${tabSql("resolved", viewer)})::int`,
    })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(...base));

  const rows = await tx
    .select({ c: conversations, contact: contactBrief })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(...base, tabSql(filters.tab, viewer)))
    .orderBy(
      ...(filters.tab === "waiting"
        ? [
            sql`case ${conversations.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
            asc(conversations.waitingSince),
            desc(conversations.id),
          ]
        : [desc(conversations.lastMessageAt), desc(conversations.id)]),
    )
    .limit(MAX_LIST_ITEMS);

  const c = countRows[0];
  return {
    items: await summariesFor(tx, ctx, rows),
    counts: { mine: c?.mine ?? 0, waiting: c?.waiting ?? 0, ai: c?.ai ?? 0, all: c?.all ?? 0, resolved: c?.resolved ?? 0 },
  };
}

/** Linha da conversa SE a pessoa pode vê-la (outra empresa, id inválido ou sem acesso = `null`, que vira 404). */
export async function findVisibleConversation(tx: Transaction, ctx: ConvCtx, id: string, options: { lock?: boolean } = {}): Promise<ConversationRow | null> {
  if (!isGuid(id)) return null;
  const query = tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.id, id)))
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) return null;
  const viewer = await loadViewer(tx, ctx);
  const visible = isVisibleTo(
    { assigneeId: row.assigneeId, status: conversationStatusSchema.catch("human_active").parse(row.status), teamId: row.teamId },
    viewer,
  );
  return visible ? row : null;
}

/** O cliente aparece em alguma conversa que a pessoa pode ver? (notas, etiquetas e tarefas seguem a mesma regra) */
export async function canAccessContact(tx: Transaction, ctx: ConvCtx, contactId: string): Promise<boolean> {
  if (!isGuid(contactId)) return false;
  const viewer = await loadViewer(tx, ctx);
  const rows = await tx
    .select({ assigneeId: conversations.assigneeId, status: conversations.status, teamId: conversations.teamId })
    .from(conversations)
    .where(and(eq(conversations.organizationId, ctx.organizationId), eq(conversations.contactId, contactId)));
  return rows.some((r) => isVisibleTo({ assigneeId: r.assigneeId, status: conversationStatusSchema.catch("human_active").parse(r.status), teamId: r.teamId }, viewer));
}

export async function canAccessTask(tx: Transaction, ctx: ConvCtx, taskId: string): Promise<boolean> {
  if (!isGuid(taskId)) return false;
  const [task] = await tx
    .select({ contactId: schema.tasks.contactId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.organizationId, ctx.organizationId), eq(schema.tasks.id, taskId)))
    .limit(1);
  return task?.contactId ? canAccessContact(tx, ctx, task.contactId) : false;
}

async function contactProfile(tx: Transaction, ctx: ServiceCtx, contact: ContactBrief & { email: string | null; isCustomer: boolean }, now: Date): Promise<ContactProfile> {
  const [consent] = await tx.select().from(schema.consents).where(eq(schema.consents.contactId, contact.id)).limit(1);
  const [panelNote] = await tx
    .select({ text: schema.contactNotes.text })
    .from(schema.contactNotes)
    .where(and(eq(schema.contactNotes.contactId, contact.id), sql`${schema.contactNotes.authorId} like 'panel:%'`))
    .orderBy(desc(schema.contactNotes.createdAt))
    .limit(1);
  const appointmentRows = await tx
    .select({
      id: schema.appointments.id,
      startsAt: schema.appointments.startsAt,
      status: schema.appointments.status,
      typeName: schema.appointmentTypes.name,
      ownerName: user.name,
    })
    .from(schema.appointments)
    .innerJoin(schema.appointmentTypes, eq(schema.appointmentTypes.id, schema.appointments.typeId))
    .leftJoin(user, eq(user.id, schema.appointments.ownerId))
    .where(and(eq(schema.appointments.organizationId, ctx.organizationId), eq(schema.appointments.contactId, contact.id)))
    .orderBy(desc(schema.appointments.startsAt))
    .limit(20);
  const taskRows = await tx
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.organizationId, ctx.organizationId), eq(schema.tasks.contactId, contact.id)))
    .orderBy(asc(schema.tasks.done), asc(schema.tasks.dueAt), desc(schema.tasks.createdAt))
    .limit(50);
  const history = await tx
    .select({ id: schema.contactEvents.id, title: schema.contactEvents.title, at: schema.contactEvents.createdAt })
    .from(schema.contactEvents)
    .where(eq(schema.contactEvents.contactId, contact.id))
    .orderBy(desc(schema.contactEvents.createdAt))
    .limit(MAX_HISTORY_ITEMS);
  return {
    id: contact.id,
    name: contact.name,
    phone: contact.phone,
    handle: contact.instagram,
    email: contact.email && z.email().safeParse(contact.email).success ? contact.email : null,
    isCustomer: contact.isCustomer,
    consent: consent ? effectiveConsentStatus(consent, now) : "pending",
    notes: panelNote?.text ?? "",
    appointments: appointmentRows.map((a) => ({
      id: a.id,
      startsAt: iso(a.startsAt),
      typeName: a.typeName,
      professional: a.ownerName ?? "—",
      status: z.enum(["pending", "confirmed", "reschedule", "done", "canceled"]).catch("pending").parse(a.status),
    })),
    tasks: taskRows.map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt ? iso(t.dueAt) : null, done: t.done })),
    history: history.map((h) => ({ id: h.id, title: h.title, at: iso(h.at) })),
  };
}

/** Mensagens → contrato, com as URLs assinadas dos anexos (uma consulta só). Chame apenas depois de checar a visibilidade da conversa. */
export async function toMessages(tx: Transaction, organizationId: string, rows: MessageRow[], contactName: string): Promise<Message[]> {
  const signed = await signMessageMedia(tx, organizationId, rows.filter((r) => r.media).map((r) => r.id));
  return rows.map((r) => toMessage(r, contactName, signed.get(r.id)));
}

export async function getConversationDetail(tx: Transaction, ctx: ConvCtx, id: string, now = new Date()): Promise<ConversationDetail | null> {
  const row = await findVisibleConversation(tx, ctx, id);
  if (!row) return null;
  const [contact] = await tx.select().from(contacts).where(eq(contacts.id, row.contactId)).limit(1);
  if (!contact) return null;
  const [summary] = await summariesFor(tx, ctx, [{ c: row, contact }]);
  if (!summary) return null;
  const thread = await tx
    .select()
    .from(messages)
    .where(eq(messages.conversationId, row.id))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(MAX_THREAD_MESSAGES);
  return {
    conversation: summary,
    messages: await toMessages(tx, ctx.organizationId, thread.reverse(), contact.name),
    contact: await contactProfile(tx, ctx, contact, now),
  };
}

export async function loadSummary(tx: Transaction, ctx: ConvCtx, row: ConversationRow): Promise<ConversationSummary | null> {
  const [contact] = await tx.select(contactBrief).from(contacts).where(eq(contacts.id, row.contactId)).limit(1);
  if (!contact) return null;
  const [summary] = await summariesFor(tx, ctx, [{ c: row, contact }]);
  return summary ?? null;
}

// ── catálogos do inbox ──────────────────────────────────────────────────────

const DEFAULT_QUICK_REPLIES = [
  { shortcut: "ola", title: "Saudação", body: "Olá! Tudo bem? Como posso te ajudar?" },
  { shortcut: "aguarde", title: "Um instante", body: "Só um instante, já verifico isso para você." },
  { shortcut: "obrigado", title: "Agradecimento", body: "Eu que agradeço! Qualquer coisa, é só chamar por aqui." },
];

const ONLINE_WINDOW_MS = 10 * 60_000;

export async function getInboxLookups(tx: Transaction, ctx: ServiceCtx, now = new Date()): Promise<InboxLookups> {
  const org = ctx.organizationId;
  const tagRows = await loadTags(tx, ctx);

  const [existingReplies] = await tx.select({ n: count() }).from(quickReplies).where(eq(quickReplies.organizationId, org));
  if ((existingReplies?.n ?? 0) === 0) {
    await tx
      .insert(quickReplies)
      .values(DEFAULT_QUICK_REPLIES.map((r) => ({ id: newId(), organizationId: org, ...r })))
      .onConflictDoNothing();
  }

  const [channelRows, teamRows, memberRows, teamLinks, agentRows, replyRows, typeRows, sessions] = await Promise.all([
    tx.select({ id: channels.id, name: channels.name, type: channels.type, status: channels.status }).from(channels).where(eq(channels.organizationId, org)).orderBy(asc(channels.createdAt)),
    tx.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.organizationId, org)).orderBy(asc(teams.priority), asc(teams.name)),
    // `member`/`user` são do Better Auth (fora do RLS): o filtro por empresa é explícito
    tx
      .select({ id: user.id, name: user.name, active: memberProfiles.active })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .leftJoin(memberProfiles, and(eq(memberProfiles.userId, member.userId), eq(memberProfiles.organizationId, org)))
      .where(eq(member.organizationId, org))
      .orderBy(asc(user.name)),
    tx.select({ teamId: teamMembers.teamId, memberRef: teamMembers.memberRef }).from(teamMembers).where(eq(teamMembers.organizationId, org)),
    tx
      .select({ id: agents.id, job: agents.job, config: agentVersions.config })
      .from(agents)
      .innerJoin(agentVersions, and(eq(agentVersions.agentId, agents.id), eq(agentVersions.number, agents.currentVersion)))
      .where(eq(agents.organizationId, org))
      .orderBy(asc(agents.createdAt)),
    tx.select().from(quickReplies).where(eq(quickReplies.organizationId, org)).orderBy(asc(quickReplies.shortcut)),
    tx
      .select({ id: schema.appointmentTypes.id, name: schema.appointmentTypes.name, durationMinutes: schema.appointmentTypes.durationMinutes })
      .from(schema.appointmentTypes)
      .where(and(eq(schema.appointmentTypes.organizationId, org), eq(schema.appointmentTypes.active, true)))
      .orderBy(asc(schema.appointmentTypes.name)),
    tx
      .select({ userId: schema.session.userId })
      .from(schema.session)
      .where(and(sql`${schema.session.expiresAt} > ${iso(now)}::timestamptz`, sql`${schema.session.updatedAt} > ${iso(new Date(now.getTime() - ONLINE_WINDOW_MS))}::timestamptz`)),
  ]);

  const online = new Set(sessions.map((s) => s.userId));
  const activeMembers = memberRows.filter((m) => m.active !== false);
  const channelKind = { whatsapp_qr: "whatsapp_qr", whatsapp_official: "whatsapp_api", instagram: "instagram" } as const;

  return {
    channels: channelRows.map((c) => ({
      id: c.id,
      name: c.name,
      kind: channelKind[c.type as keyof typeof channelKind] ?? "whatsapp_qr",
      status: c.status === "connected" ? "connected" : "disconnected",
    })),
    teams: teamRows,
    members: activeMembers.map((m) => ({
      id: m.id,
      name: m.name,
      teamIds: teamLinks.filter((l) => l.memberRef === m.id).map((l) => l.teamId),
      online: online.has(m.id),
    })),
    agents: agentRows.map((a) => ({
      id: a.id,
      name: z.object({ name: z.string() }).safeParse(a.config).data?.name ?? "Agente",
      job: z.enum(["support", "follow_up", "scheduling", "instagram_dm", "comments"]).catch("support").parse(a.job),
    })),
    tags: tagRows,
    quickReplies: replyRows.map((r) => ({ id: r.id, shortcut: r.shortcut, title: r.title, body: r.body })),
    appointmentTypes: typeRows,
    professionals: [...new Set(activeMembers.map((m) => m.name))],
  };
}

// ── agente que atende ───────────────────────────────────────────────────────

export type ActiveAgent = { id: string; name: string; job: string; config: z.infer<typeof agentConfigSchema> };

/** Agente ATIVO por id, com a configuração da versão em vigor. `null` se não existe, não é da empresa ou não está ativo. */
export async function loadActiveAgent(tx: Transaction, organizationId: string, agentId: string | null): Promise<ActiveAgent | null> {
  if (!agentId || !isGuid(agentId)) return null;
  const [row] = await tx
    .select({ id: agents.id, job: agents.job, status: agents.status, config: agentVersions.config })
    .from(agents)
    .innerJoin(agentVersions, and(eq(agentVersions.agentId, agents.id), eq(agentVersions.number, agents.currentVersion)))
    .where(and(eq(agents.organizationId, organizationId), eq(agents.id, agentId)))
    .limit(1);
  if (!row || row.status !== "active") return null;
  const config = agentConfigSchema.safeParse(row.config);
  if (!config.success) return null;
  return { id: row.id, name: config.data.name, job: row.job, config: config.data };
}

