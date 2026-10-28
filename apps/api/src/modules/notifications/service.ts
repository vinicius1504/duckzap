import { NOTIFICATIONS_PAGE, type NotificationKind, type NotificationList } from "@duckzap/contracts/notifications";
import { schema, type Transaction } from "@duckzap/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { v7 } from "uuid";
import { queueRealtime } from "../../lib/realtime";
import { isGuid } from "../contacts/http";
import { notificationRecipients } from "./logic";

const { notifications, member, memberProfiles, teamMembers } = schema;

/** Lidas com mais de 60 dias saem; apaga em lote pequeno a cada gravação (sem job novo). */
export const READ_RETENTION_DAYS = 60;
export const RETENTION_BATCH = 50;

const log = { warn: (message: string, meta?: Record<string, unknown>) => console.warn(message, meta ?? "") };

export type NotificationPayload = { kind: NotificationKind; title: string; body: string; link: string | null };

// ── leitura ─────────────────────────────────────────────────────────────────

async function unreadCountOf(tx: Transaction, organizationId: string, userId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.organizationId, organizationId), eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** As notificações da própria pessoa (mais novas primeiro, até 30) e o total de não lidas. */
export async function listNotifications(tx: Transaction, organizationId: string, userId: string): Promise<NotificationList> {
  const rows = await tx
    .select()
    .from(notifications)
    .where(and(eq(notifications.organizationId, organizationId), eq(notifications.userId, userId)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(NOTIFICATIONS_PAGE);
  return {
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationKind,
      title: r.title,
      body: r.body,
      link: r.link,
      createdAt: r.createdAt.toISOString(),
      read: r.readAt !== null,
    })),
    unreadCount: await unreadCountOf(tx, organizationId, userId),
  };
}

/**
 * Marca como lidas SÓ as da própria pessoa: id de outra pessoa/empresa (ou malformado) é ignorado em silêncio, para não
 * revelar existência. Idempotente: quem já foi lida mantém o `read_at` original.
 */
export async function markRead(
  tx: Transaction,
  organizationId: string,
  userId: string,
  input: { all?: boolean; ids?: readonly string[] },
  now = new Date(),
): Promise<{ unreadCount: number }> {
  const mine = and(eq(notifications.organizationId, organizationId), eq(notifications.userId, userId), isNull(notifications.readAt));
  if (input.all === true) {
    await tx.update(notifications).set({ readAt: now }).where(mine);
  } else {
    const ids = [...new Set((input.ids ?? []).filter(isGuid))];
    if (ids.length > 0) await tx.update(notifications).set({ readAt: now }).where(and(mine, inArray(notifications.id, ids)));
  }
  return { unreadCount: await unreadCountOf(tx, organizationId, userId) };
}

// ── gravação ────────────────────────────────────────────────────────────────

/** Apaga um lote pequeno de notificações lidas há mais de 60 dias da empresa. */
async function pruneRead(tx: Transaction, organizationId: string, now: Date) {
  const cutoff = new Date(now.getTime() - READ_RETENTION_DAYS * 86_400_000);
  await tx.execute(sql`
    delete from notifications
    where id in (
      select id from notifications
      where organization_id = ${organizationId} and read_at is not null and read_at < ${cutoff.toISOString()}::timestamptz
      limit ${RETENTION_BATCH}
    )`);
}

/** Só grava (sem aviso em tempo real). Devolve quantas linhas entraram. */
async function insertNotifications(tx: Transaction, organizationId: string, userIds: readonly string[], payload: NotificationPayload, now: Date): Promise<number> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return 0;
  await tx.insert(notifications).values(
    unique.map((userId) => ({ id: v7(), organizationId, userId, kind: payload.kind, title: payload.title, body: payload.body, link: payload.link, createdAt: now })),
  );
  await pruneRead(tx, organizationId, now);
  return unique.length;
}

/**
 * Cria uma notificação para cada pessoa (ids repetidos viram um; lista vazia não faz nada) e avisa o sino em tempo real
 * UMA vez. O evento só sai depois do commit (`queueRealtime`). Chame com pessoas da própria empresa.
 */
export async function notifyMembers(tx: Transaction, organizationId: string, userIds: readonly string[], payload: NotificationPayload, now = new Date()): Promise<number> {
  const inserted = await insertNotifications(tx, organizationId, userIds, payload, now);
  if (inserted > 0) queueRealtime(tx, organizationId, { type: "notifications.invalidate" });
  return inserted;
}

// ── quem é "a equipe" ───────────────────────────────────────────────────────

/** Pessoa ativa = sem perfil ou com `active` diferente de false (mesma regra de Equipe/Conversas). */
const activeProfile = or(isNull(memberProfiles.active), eq(memberProfiles.active, true));

async function activeMembers(tx: Transaction, organizationId: string, extra: ReturnType<typeof eq>): Promise<string[]> {
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .leftJoin(memberProfiles, and(eq(memberProfiles.userId, member.userId), eq(memberProfiles.organizationId, organizationId)))
    .where(and(eq(member.organizationId, organizationId), activeProfile, extra));
  return rows.map((r) => r.userId);
}

/** Destinatários do aviso de agendamento: equipe da conversa + responsável; sem equipe com gente, proprietários e admins. */
export async function resolveAppointmentRecipients(tx: Transaction, organizationId: string, input: { teamId: string | null; ownerId: string | null }): Promise<string[]> {
  let team: string[] = [];
  if (input.teamId) {
    const rows = await tx
      .select({ ref: teamMembers.memberRef })
      .from(teamMembers)
      .where(and(eq(teamMembers.organizationId, organizationId), eq(teamMembers.teamId, input.teamId)));
    // `memberRef` pode ser id de convite pendente: só entra quem já é pessoa da empresa e está ativa
    if (rows.length > 0) team = await activeMembers(tx, organizationId, inArray(member.userId, rows.map((r) => r.ref)));
  }
  const owner = input.ownerId ? ((await activeMembers(tx, organizationId, eq(member.userId, input.ownerId)))[0] ?? null) : null;
  const admins = team.length === 0 ? await activeMembers(tx, organizationId, inArray(member.role, ["owner", "admin"])) : [];
  return notificationRecipients({ teamMembers: team, owner, admins });
}

/**
 * Avisa a equipe de um agendamento feito pela IA, DENTRO da transação do agendamento mas num savepoint: se o aviso
 * falhar, só ele é desfeito (o agendamento segue) e a falha vai para o log sem dado pessoal.
 */
export async function notifyAppointmentTeam(
  tx: Transaction,
  organizationId: string,
  input: { teamId: string | null; ownerId: string | null; payload: NotificationPayload },
  now = new Date(),
): Promise<void> {
  try {
    const inserted = await tx.transaction(async (sp) => {
      const recipients = await resolveAppointmentRecipients(sp, organizationId, input);
      return insertNotifications(sp, organizationId, recipients, input.payload, now);
    });
    // o evento é guardado na transação externa (a que o chamador publica depois do commit)
    if (inserted > 0) queueRealtime(tx, organizationId, { type: "notifications.invalidate" });
  } catch (error) {
    log.warn("notifications: falha ao avisar a equipe; o agendamento foi mantido", { error: error instanceof Error ? error.name : "unknown" });
  }
}
