import type { AttentionItem, HomeOverview, TaskPriority } from "@duckzap/contracts/home";
import { schema, type Transaction } from "@duckzap/db";
import { and, asc, count, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { queueRealtime } from "../../lib/realtime";
import { dayRangeUtc, shiftDay, todayIn, zonedDay } from "../appointments/time";
import { isGuid } from "../contacts/http";
import { fail, newId, ok, type Result, type ServiceCtx } from "../contacts/result";
import { OPEN_STATUSES } from "../conversations/logic";
import { loadTags, loadViewer, visibilitySql, type ConvCtx } from "../conversations/queries";
import { ageLabel, assigneeLabel, distributePercent, dueLabel, lastDays, percentOf, periodRange, TASK_PRIORITY_ORDER, type Period } from "./logic";

const { conversations, contacts, contactTags, tags, appointments, channels, messages, tasks, agents, agentVersions, user } = schema;

export type HomeCtx = ConvCtx & { canViewTeamMetrics: boolean };
type TaskRow = typeof tasks.$inferSelect;
type HomeTask = HomeOverview["tasks"][number];

const OPEN = [...OPEN_STATUSES];

const priorityOf = (value: string): TaskPriority => z.enum(["urgent", "high", "medium", "low"]).catch("medium").parse(value);

// ── tarefas ─────────────────────────────────────────────────────────────────

/** Quem vê uma tarefa: a pessoa responsável, quem a criou e, com as métricas da equipe, qualquer pessoa da empresa. */
const taskVisible = (ctx: HomeCtx) =>
  ctx.canViewTeamMetrics ? undefined : or(eq(tasks.assigneeId, ctx.userId), eq(tasks.createdBy, ctx.userId));

async function toHomeTasks(tx: Transaction, ctx: HomeCtx, rows: TaskRow[], now: Date): Promise<HomeTask[]> {
  const ids = [...new Set(rows.map((r) => r.assigneeId))];
  const names = ids.length ? await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids)) : [];
  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    dueLabel: dueLabel(t, now, ctx.timeZone),
    assignee: assigneeLabel(t.assigneeId, ctx.userId, names.find((n) => n.id === t.assigneeId)?.name ?? null),
    priority: priorityOf(t.priority),
    done: t.done,
  }));
}

async function listTasks(tx: Transaction, ctx: HomeCtx, now: Date): Promise<HomeTask[]> {
  const startOfToday = dayRangeUtc(todayIn(ctx.timeZone, now), todayIn(ctx.timeZone, now), ctx.timeZone).start;
  const rows = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, ctx.organizationId),
        taskVisible(ctx),
        // concluídas só aparecem no dia em que foram concluídas
        or(eq(tasks.done, false), gte(tasks.doneAt, startOfToday)),
      ),
    )
    .orderBy(asc(tasks.done), asc(sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`), sql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt))
    .limit(30);
  const mapped = await toHomeTasks(tx, ctx, rows, now);
  // estável por prioridade dentro de cada grupo (a ordenação SQL já cobre; isto só garante o contrato em testes)
  return mapped.sort((a, b) => Number(a.done) - Number(b.done) || TASK_PRIORITY_ORDER[a.priority] - TASK_PRIORITY_ORDER[b.priority]);
}

export async function createTask(tx: Transaction, ctx: HomeCtx, title: string, now = new Date()): Promise<Result<HomeTask, never>> {
  const [row] = await tx
    .insert(tasks)
    .values({ id: newId(), organizationId: ctx.organizationId, title, assigneeId: ctx.userId, createdBy: ctx.userId, createdAt: now })
    .returning();
  if (!row) throw new Error("tarefa não gravada");
  const [mapped] = await toHomeTasks(tx, ctx, [row], now);
  if (!mapped) throw new Error("tarefa não mapeada");
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok(mapped);
}

export async function setTaskDone(tx: Transaction, ctx: HomeCtx, id: string, done: boolean, now = new Date()): Promise<Result<null, "not_found">> {
  if (!isGuid(id)) return fail("not_found", "Tarefa não encontrada.");
  const updated = await tx
    .update(tasks)
    .set({ done, doneAt: done ? now : null })
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.id, id), taskVisible(ctx)))
    .returning({ id: tasks.id });
  if (updated.length) queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return updated.length ? ok(null) : fail("not_found", "Tarefa não encontrada.");
}

// ── visão geral ─────────────────────────────────────────────────────────────

export async function getHomeOverview(tx: Transaction, ctx: HomeCtx, period: Period, now = new Date()): Promise<HomeOverview> {
  const viewer = await loadViewer(tx, ctx);
  const visible = and(eq(conversations.organizationId, ctx.organizationId), visibilitySql(viewer));
  const range = periodRange(period, now, ctx.timeZone);
  const today = periodRange("today", now, ctx.timeZone);

  // KPIs --------------------------------------------------------------------------
  const [kpi] = await tx
    .select({
      open: sql<number>`count(*) filter (where ${inArray(conversations.status, OPEN)})::int`,
      newToday: sql<number>`count(*) filter (where ${gte(conversations.createdAt, today.from)} and ${lt(conversations.createdAt, today.to)})::int`,
      firstResponse: sql<number | null>`round(avg(${conversations.firstResponseSeconds}) filter (where ${gte(conversations.createdAt, range.from)} and ${lt(conversations.createdAt, range.to)}))::int`,
      handling: sql<number | null>`round(avg(extract(epoch from (${conversations.resolvedAt} - ${conversations.createdAt}))) filter (where ${eq(conversations.status, "resolved")} and ${gte(conversations.resolvedAt, range.from)} and ${lt(conversations.resolvedAt, range.to)}))::int`,
      resolved: sql<number>`count(*) filter (where ${eq(conversations.status, "resolved")} and ${gte(conversations.resolvedAt, range.from)} and ${lt(conversations.resolvedAt, range.to)})::int`,
      resolvedByAi: sql<number>`count(*) filter (where ${eq(conversations.status, "resolved")} and ${eq(conversations.resolvedBy, "ai")} and ${gte(conversations.resolvedAt, range.from)} and ${lt(conversations.resolvedAt, range.to)})::int`,
    })
    .from(conversations)
    .where(visible);

  // conversas por dia (sempre os últimos 7 dias, como o título do gráfico) -------------
  const days = lastDays(7, now, ctx.timeZone);
  const perDayRange = dayRangeUtc(days[0] ?? today.fromDay, days[days.length - 1] ?? today.toDay, ctx.timeZone);
  const perDayRows = await tx
    .select({ day: sql<string>`to_char(${conversations.createdAt} at time zone ${ctx.timeZone}, 'YYYY-MM-DD')`, n: count() })
    .from(conversations)
    .where(and(visible, gte(conversations.createdAt, perDayRange.start), lt(conversations.createdAt, perDayRange.end)))
    .groupBy(sql`1`);
  const conversationsPerDay = days.map((date) => ({ date, count: perDayRows.find((r) => r.day === date)?.n ?? 0 }));

  // funil: clientes com conversa no período, por etapa --------------------------------
  const stageTags = (await loadTags(tx, ctx)).filter((t) => t.funnelStage !== null).sort((a, b) => (a.funnelStage ?? 0) - (b.funnelStage ?? 0));
  const activeContacts = await tx
    .selectDistinct({ contactId: conversations.contactId })
    .from(conversations)
    .where(and(visible, gte(conversations.lastMessageAt, range.from), lt(conversations.lastMessageAt, range.to)))
    .limit(5000);
  const stageByContact = new Map<string, number>();
  if (activeContacts.length) {
    const rows = await tx
      .select({ contactId: contactTags.contactId, stage: tags.funnelStage })
      .from(contactTags)
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(and(inArray(contactTags.contactId, activeContacts.map((c) => c.contactId)), isNotNull(tags.funnelStage)));
    for (const r of rows) stageByContact.set(r.contactId, Math.max(stageByContact.get(r.contactId) ?? 0, r.stage ?? 0));
  }
  const stageCounts = stageTags.map((t) => activeContacts.filter((c) => (stageByContact.get(c.contactId) ?? stageTags[0]?.funnelStage ?? 1) === t.funnelStage).length);
  const stagePercent = distributePercent(stageCounts);
  const funnel = stageTags.map((t, i) => ({ stage: t.name, percent: stagePercent[i] ?? 0 }));

  // conversão semanal: conversas que viraram agendamento ou venda (etapa final) -----------
  const weekStart = shiftDay(today.toDay, -27);
  const weekRange = dayRangeUtc(weekStart, today.toDay, ctx.timeZone);
  const lastStage = stageTags[stageTags.length - 1];
  const converted = await tx
    .select({
      createdAt: conversations.createdAt,
      won: sql<boolean>`(${exists(
        tx
          .select({ one: sql`1` })
          .from(appointments)
          .where(and(eq(appointments.contactId, conversations.contactId), ne(appointments.status, "canceled"), sql`${appointments.createdAt} >= ${conversations.createdAt}`)),
      )} or ${
        lastStage
          ? exists(tx.select({ one: sql`1` }).from(contactTags).where(and(eq(contactTags.contactId, conversations.contactId), eq(contactTags.tagId, lastStage.id))))
          : sql`false`
      })`,
    })
    .from(conversations)
    .where(and(visible, gte(conversations.createdAt, weekRange.start), lt(conversations.createdAt, weekRange.end)))
    .limit(5000);
  const weeklyConversion = [0, 1, 2, 3].map((i) => {
    const startDay = shiftDay(weekStart, i * 7);
    const endDay = shiftDay(startDay, 6);
    const inWeek = converted.filter((r) => {
      const d = zonedDay(r.createdAt.toISOString(), ctx.timeZone);
      return d >= startDay && d <= endDay;
    });
    return { label: `Sem ${i + 1}`, percent: percentOf(inWeek.filter((r) => r.won).length, inWeek.length) };
  });

  return {
    attention: await attention(tx, ctx, visible, now),
    kpis: {
      openConversations: kpi?.open ?? 0,
      newToday: kpi?.newToday ?? 0,
      firstResponseSeconds: kpi?.firstResponse ?? 0,
      handlingSeconds: kpi?.handling ?? 0,
      resolvedByAiPercent: percentOf(kpi?.resolvedByAi ?? 0, kpi?.resolved ?? 0),
    },
    conversationsPerDay,
    funnel,
    weeklyConversion,
    tasks: await listTasks(tx, ctx, now),
    conversationsByAgent: ctx.canViewTeamMetrics ? await byAgent(tx, ctx, range) : [],
  };
}

// ── "Precisa de você" ───────────────────────────────────────────────────────

async function attention(tx: Transaction, ctx: HomeCtx, visible: ReturnType<typeof and>, now: Date): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  const [queue] = await tx
    .select({ n: count(), oldest: sql<Date | null>`min(${conversations.waitingSince})` })
    .from(conversations)
    .where(and(visible, eq(conversations.status, "handoff_requested")));
  if (queue && queue.n > 0) {
    items.push({
      id: "att_queue",
      kind: "queue",
      title: queue.n === 1 ? "1 conversa espera um atendente" : `${queue.n} conversas esperam um atendente`,
      detail: queue.oldest ? `A mais antiga está há ${ageLabel(new Date(queue.oldest), now)} na fila` : "Assuma para começar o atendimento",
      href: "/conversas?aba=aguardando",
    });
  }

  // sem resposta: cliente falou por último há mais de 15 min numa conversa com pessoa (a fila já é o item acima)
  const [stale] = await tx
    .select({ id: conversations.id, name: contacts.name, preview: conversations.lastMessagePreview, at: conversations.lastInboundAt })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(visible, eq(conversations.status, "human_active"), isNotNull(conversations.lastInboundAt), lt(conversations.lastInboundAt, new Date(now.getTime() - 15 * 60_000)), or(isNull(conversations.lastReplyAt), sql`${conversations.lastReplyAt} < ${conversations.lastInboundAt}`)))
    .orderBy(asc(conversations.lastInboundAt))
    .limit(1);
  if (stale) {
    items.push({
      id: "att_unanswered",
      kind: "unanswered",
      title: `${stale.name} sem resposta há ${ageLabel(stale.at ?? now, now)}`,
      detail: stale.preview ? `“${stale.preview}”` : "Mensagem sem texto",
      href: `/conversas?conversa=${stale.id}`,
    });
  }

  const down = await tx
    .select({ id: channels.id, name: channels.name, status: channels.status })
    .from(channels)
    .where(and(eq(channels.organizationId, ctx.organizationId), inArray(channels.status, ["disconnected", "banned"])))
    .orderBy(asc(channels.name))
    .limit(3);
  for (const ch of down) {
    items.push({
      id: `att_channel_${ch.id}`,
      kind: "channel_down",
      title: ch.status === "banned" ? `${ch.name} foi bloqueado pelo WhatsApp` : `${ch.name} está desconectado`,
      detail: "Reconecte para não perder mensagens",
      href: "/canais",
    });
  }

  const tomorrow = shiftDay(todayIn(ctx.timeZone, now), 1);
  const tomorrowRange = dayRangeUtc(tomorrow, tomorrow, ctx.timeZone);
  const pending = await tx
    .select({ name: contacts.name, startsAt: appointments.startsAt })
    .from(appointments)
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .where(and(eq(appointments.organizationId, ctx.organizationId), eq(appointments.status, "pending"), gte(appointments.startsAt, tomorrowRange.start), lt(appointments.startsAt, tomorrowRange.end)))
    .orderBy(asc(appointments.startsAt))
    .limit(50);
  if (pending.length > 0) {
    const hour = (d: Date) => {
      const [h = "0", m = "00"] = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).split(":");
      return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
    };
    items.push({
      id: "att_appointments",
      kind: "appointments_to_confirm",
      title: pending.length === 1 ? "1 agendamento a confirmar amanhã" : `${pending.length} agendamentos a confirmar amanhã`,
      detail: pending
        .slice(0, 3)
        .map((a) => `${a.name} às ${hour(a.startsAt)}`)
        .join(" · "),
      href: "/agenda",
    });
  }
  return items;
}

// ── conversas por atendente ─────────────────────────────────────────────────

async function byAgent(tx: Transaction, ctx: ServiceCtx, range: { from: Date; to: Date }): Promise<HomeOverview["conversationsByAgent"]> {
  const org = ctx.organizationId;
  const humans = await tx
    .select({ id: conversations.assigneeId, name: user.name, n: count() })
    .from(conversations)
    .innerJoin(user, eq(user.id, conversations.assigneeId))
    .where(and(eq(conversations.organizationId, org), gte(conversations.createdAt, range.from), lt(conversations.createdAt, range.to)))
    .groupBy(conversations.assigneeId, user.name);
  const ais = await tx
    .select({ agentId: conversations.agentId, config: agentVersions.config, n: sql<number>`count(distinct ${conversations.id})::int` })
    .from(conversations)
    .innerJoin(agents, eq(agents.id, conversations.agentId))
    .innerJoin(agentVersions, and(eq(agentVersions.agentId, agents.id), eq(agentVersions.number, agents.currentVersion)))
    .where(
      and(
        eq(conversations.organizationId, org),
        gte(conversations.createdAt, range.from),
        lt(conversations.createdAt, range.to),
        exists(tx.select({ one: sql`1` }).from(messages).where(and(eq(messages.conversationId, conversations.id), eq(messages.senderKind, "agent")))),
      ),
    )
    .groupBy(conversations.agentId, agentVersions.config);
  const rows: HomeOverview["conversationsByAgent"] = [
    ...ais.map((a) => ({ name: `${z.object({ name: z.string() }).safeParse(a.config).data?.name ?? "Agente"} (IA)`, count: a.n, isAi: true })),
    ...humans.map((h) => ({ name: h.name, count: h.n, isAi: false })),
  ];
  return rows.sort((a, b) => b.count - a.count).slice(0, 10);
}
