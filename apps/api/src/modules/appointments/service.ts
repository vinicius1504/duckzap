import {
  appointmentSchema,
  appointmentStatusSchema,
  reminderKindSchema,
  type AgendaOwner,
  type Appointment,
  type AppointmentRangeQuery,
  type AppointmentStatus,
  type AppointmentType,
  type CalendarSync,
  type ReminderSettings,
  appointmentInputSchema,
  appointmentTypeInputSchema,
  conflictQuerySchema,
} from "@duckzap/contracts/appointments";
import { schema, withOrg, type Database, type Transaction } from "@duckzap/db";
import { and, asc, eq, gt, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { queueRealtime } from "../../lib/realtime";
import { listOrgOwners, recordContactEvent } from "../contacts/service";
import {
  PG_EXCLUSION_VIOLATION,
  chunk,
  fail,
  newId,
  ok,
  pgErrorCode,
  type Result,
  type ServiceCtx,
} from "../contacts/result";
import {
  DEFAULT_REMINDER_SETTINGS,
  DISCONNECTED_SYNC,
  canTransition,
  computeReminders,
  interpretReminderReply,
  nextSyncState,
  statusAfterReply,
} from "./logic";
import type { CalendarPort } from "./ports";
import { dayRangeUtc, zonedToUtc } from "./time";

const { appointments, appointmentTypes, appointmentReminders, appointmentReminderSettings, agendaSettings, calendarSyncs, contacts, member } = schema;

export type AppointmentInputData = z.output<typeof appointmentInputSchema>;
export type ConflictQueryData = z.output<typeof conflictQuerySchema>;
export type AppointmentTypeInputData = z.input<typeof appointmentTypeInputSchema>;

export const MAX_RANGE_DAYS = 100;

/** Resultado de salvar: em conflito devolve os agendamentos que batem (a tela mostra o aviso). */
export type SaveResult = Result<Appointment, "not_found" | "invalid" | "conflict", { conflicts?: Appointment[] }>;

type AppointmentRow = typeof appointments.$inferSelect;

// Mapeamento ---------------------------------------------------------------------------------------------------

async function loadAppointments(tx: Transaction, where: SQL | undefined): Promise<Appointment[]> {
  const rows = await tx
    .select({ appointment: appointments, contactName: contacts.name, contactPhone: contacts.phone })
    .from(appointments)
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .where(where)
    .orderBy(asc(appointments.startsAt), asc(appointments.id));
  if (rows.length === 0) return [];
  const reminders = new Map<string, Appointment["reminders"]>();
  for (const batch of chunk(rows.map((r) => r.appointment.id), 2000)) {
    const found = await tx.select().from(appointmentReminders).where(inArray(appointmentReminders.appointmentId, batch)).orderBy(asc(appointmentReminders.scheduledFor));
    for (const r of found) {
      reminders.set(r.appointmentId, [
        ...(reminders.get(r.appointmentId) ?? []),
        { kind: reminderKindSchema.catch("24h").parse(r.kind), status: r.status === "sent" ? "sent" : r.status === "skipped" ? "skipped" : "scheduled", at: r.scheduledFor.toISOString() },
      ]);
    }
  }
  return rows.map(({ appointment: a, contactName, contactPhone }) =>
    appointmentSchema.parse({
      id: a.id,
      contactId: a.contactId,
      contactName,
      contactPhone,
      typeId: a.typeId,
      ownerId: a.ownerId,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: appointmentStatusSchema.catch("pending").parse(a.status),
      notes: a.notes,
      source: a.source,
      sourceName: a.sourceName,
      reminders: reminders.get(a.id) ?? [],
      confirmationReply: a.confirmationReply,
      syncedToGoogle: a.syncedToGoogle,
      createdAt: a.createdAt.toISOString(),
    }),
  );
}

const inOrg = (ctx: ServiceCtx) => eq(appointments.organizationId, ctx.organizationId);

// Consultas ----------------------------------------------------------------------------------------------------

export async function listAppointments(tx: Transaction, ctx: ServiceCtx, query: AppointmentRangeQuery): Promise<Appointment[]> {
  const { start, end } = dayRangeUtc(query.from, query.to, ctx.timeZone);
  return loadAppointments(
    tx,
    and(
      inOrg(ctx),
      gte(appointments.startsAt, start),
      lt(appointments.startsAt, end),
      query.ownerId ? eq(appointments.ownerId, query.ownerId) : undefined,
      query.typeId ? eq(appointments.typeId, query.typeId) : undefined,
    ),
  );
}

export async function listAppointmentsForContact(tx: Transaction, ctx: ServiceCtx, contactId: string) {
  return loadAppointments(tx, and(inOrg(ctx), eq(appointments.contactId, contactId)));
}

export async function getAppointment(tx: Transaction, ctx: ServiceCtx, id: string): Promise<Appointment | null> {
  const [found] = await loadAppointments(tx, and(inOrg(ctx), eq(appointments.id, id)));
  return found ?? null;
}

/** Agendamentos do mesmo responsável que se sobrepõem a [startsAt, endsAt). Cancelados não ocupam horário. */
async function conflictsFor(tx: Transaction, ctx: ServiceCtx, ownerId: string, startsAt: Date, endsAt: Date, excludeId: string | null) {
  return loadAppointments(
    tx,
    and(
      inOrg(ctx),
      eq(appointments.ownerId, ownerId),
      ne(appointments.status, "canceled"),
      lt(appointments.startsAt, endsAt),
      gt(appointments.endsAt, startsAt),
      excludeId ? ne(appointments.id, excludeId) : undefined,
    ),
  );
}

function slot(date: string, time: string, durationMinutes: number, timeZone: string) {
  const startsAt = new Date(zonedToUtc(date, time, timeZone));
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000) };
}

export async function findAppointmentConflicts(tx: Transaction, ctx: ServiceCtx, query: ConflictQueryData) {
  const { startsAt, endsAt } = slot(query.date, query.time, query.durationMinutes, ctx.timeZone);
  return conflictsFor(tx, ctx, query.ownerId, startsAt, endsAt, query.excludeId);
}

// Escrita -------------------------------------------------------------------------------------------------------

/** Serializa gravações do mesmo responsável (a checagem de conflito + insert não pode correr em paralelo). */
async function lockOwners(tx: Transaction, ctx: ServiceCtx, ownerIds: string[]) {
  for (const ownerId of [...new Set(ownerIds)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`appt:${ctx.organizationId}:${ownerId}`}, 0))`);
  }
}

async function isMember(tx: Transaction, ctx: ServiceCtx, userId: string) {
  // `member` é do Better Auth e fica fora do RLS: o filtro por empresa é explícito.
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, ctx.organizationId), eq(member.userId, userId)))
    .limit(1);
  return Boolean(row);
}

async function validateRefs(tx: Transaction, ctx: ServiceCtx, input: AppointmentInputData): Promise<Result<null, "invalid">> {
  const [type] = await tx.select().from(appointmentTypes).where(eq(appointmentTypes.id, input.typeId)).limit(1);
  if (!type) return fail("invalid", "Tipo de atendimento não encontrado.");
  const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1);
  if (!contact) return fail("invalid", "Cliente não encontrado.");
  if (!(await isMember(tx, ctx, input.ownerId))) return fail("invalid", "Responsável não encontrado.");
  return ok(null);
}

export async function getReminderSettings(tx: Transaction, ctx: ServiceCtx): Promise<ReminderSettings> {
  const [rows, general] = await Promise.all([
    tx.select().from(appointmentReminderSettings).where(eq(appointmentReminderSettings.organizationId, ctx.organizationId)),
    tx.select().from(agendaSettings).where(eq(agendaSettings.organizationId, ctx.organizationId)).limit(1),
  ]);
  const saved = new Map(rows.map((r) => [r.kind, r]));
  return {
    reminders: DEFAULT_REMINDER_SETTINGS.reminders.map((d) => {
      const row = saved.get(d.kind);
      return row ? { kind: d.kind, enabled: row.enabled, message: row.message } : { ...d };
    }),
    confirmByReply: general[0]?.confirmByReply ?? DEFAULT_REMINDER_SETTINGS.confirmByReply,
  };
}

/** Recria as linhas de lembrete do agendamento (apaga as antigas: horário novo, lembretes novos). */
async function rebuildReminders(tx: Transaction, ctx: ServiceCtx, appointment: Pick<AppointmentRow, "id" | "startsAt" | "status">, now: Date) {
  const settings = await getReminderSettings(tx, ctx);
  await tx.delete(appointmentReminders).where(eq(appointmentReminders.appointmentId, appointment.id));
  const planned = computeReminders({ startsAt: appointment.startsAt, status: appointmentStatusSchema.catch("pending").parse(appointment.status) }, settings, now);
  if (planned.length === 0) return;
  await tx.insert(appointmentReminders).values(
    planned.map((r) => ({
      id: newId(),
      organizationId: ctx.organizationId,
      appointmentId: appointment.id,
      kind: r.kind,
      scheduledFor: r.at,
      status: r.status,
    })),
  );
}

export type CreateOptions = { source?: "manual" | "ai_agent" | "google"; sourceName?: string | null };

async function conflictFailure(tx: Transaction, ctx: ServiceCtx, ownerId: string, startsAt: Date, endsAt: Date, excludeId: string | null): Promise<SaveResult> {
  const conflicts = await conflictsFor(tx, ctx, ownerId, startsAt, endsAt, excludeId);
  return { ...fail("conflict", "Este horário bate com outro agendamento do mesmo responsável."), conflicts };
}

export async function createAppointment(
  tx: Transaction,
  ctx: ServiceCtx,
  input: AppointmentInputData,
  options: CreateOptions = {},
  now = new Date(),
): Promise<SaveResult> {
  const refs = await validateRefs(tx, ctx, input);
  if (!refs.ok) return refs;
  const { startsAt, endsAt } = slot(input.date, input.time, input.durationMinutes, ctx.timeZone);

  await lockOwners(tx, ctx, [input.ownerId]);
  const conflicts = await conflictsFor(tx, ctx, input.ownerId, startsAt, endsAt, null);
  if (conflicts.length && !input.allowConflict) {
    return { ...fail("conflict", "Este horário bate com outro agendamento do mesmo responsável."), conflicts };
  }

  const id = newId();
  try {
    // savepoint: se a restrição de exclusão (appointments.sql.md) barrar, a transação continua utilizável
    await tx.transaction(async (sp) => {
      await sp.insert(appointments).values({
        id,
        organizationId: ctx.organizationId,
        contactId: input.contactId,
        typeId: input.typeId,
        ownerId: input.ownerId,
        startsAt,
        endsAt,
        status: "pending",
        source: options.source ?? "manual",
        sourceName: options.sourceName === undefined ? ctx.userName : options.sourceName,
        notes: input.notes || null,
        allowConflict: conflicts.length > 0,
        createdBy: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return conflictFailure(tx, ctx, input.ownerId, startsAt, endsAt, null);
    throw error;
  }
  await rebuildReminders(tx, ctx, { id, startsAt, status: "pending" }, now);
  await recordContactEvent(tx, ctx.organizationId, input.contactId, "appointment", "Agendamento criado", `${input.date} às ${input.time}`);
  const created = await getAppointment(tx, ctx, id);
  if (!created) throw new Error("agendamento criado não encontrado");
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok(created);
}

export async function updateAppointment(
  tx: Transaction,
  ctx: ServiceCtx,
  id: string,
  input: AppointmentInputData,
  now = new Date(),
): Promise<SaveResult> {
  const [existing] = await tx.select().from(appointments).where(and(inOrg(ctx), eq(appointments.id, id))).limit(1);
  if (!existing) return fail("not_found", "Agendamento não encontrado.");
  const refs = await validateRefs(tx, ctx, input);
  if (!refs.ok) return refs;
  const { startsAt, endsAt } = slot(input.date, input.time, input.durationMinutes, ctx.timeZone);

  await lockOwners(tx, ctx, [input.ownerId, existing.ownerId]);
  const blocking = existing.status !== "canceled";
  const conflicts = blocking ? await conflictsFor(tx, ctx, input.ownerId, startsAt, endsAt, id) : [];
  if (conflicts.length && !input.allowConflict) {
    return { ...fail("conflict", "Este horário bate com outro agendamento do mesmo responsável."), conflicts };
  }

  // remarcado: volta a pedir confirmação e reagenda os lembretes
  const moved = existing.startsAt.getTime() !== startsAt.getTime();
  const status = moved && existing.status !== "canceled" ? "pending" : existing.status;
  try {
    await tx.transaction(async (sp) => {
      await sp
        .update(appointments)
        .set({
          contactId: input.contactId,
          typeId: input.typeId,
          ownerId: input.ownerId,
          startsAt,
          endsAt,
          notes: input.notes || null,
          status,
          confirmationReply: moved ? null : existing.confirmationReply,
          allowConflict: conflicts.length > 0,
          syncedToGoogle: moved || existing.ownerId !== input.ownerId ? false : existing.syncedToGoogle,
          updatedAt: now,
        })
        .where(and(inOrg(ctx), eq(appointments.id, id)));
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return conflictFailure(tx, ctx, input.ownerId, startsAt, endsAt, id);
    throw error;
  }
  if (moved) await rebuildReminders(tx, ctx, { id, startsAt, status }, now);
  const updated = await getAppointment(tx, ctx, id);
  if (!updated) throw new Error("agendamento atualizado não encontrado");
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok(updated);
}

export async function setAppointmentStatus(
  tx: Transaction,
  ctx: ServiceCtx,
  id: string,
  next: AppointmentStatus,
  now = new Date(),
): Promise<Result<Appointment, "not_found" | "invalid_transition" | "conflict">> {
  const [existing] = await tx.select().from(appointments).where(and(inOrg(ctx), eq(appointments.id, id))).limit(1);
  if (!existing) return fail("not_found", "Agendamento não encontrado.");
  const current = appointmentStatusSchema.catch("pending").parse(existing.status);
  if (!canTransition(current, next)) {
    return fail("invalid_transition", "Esta mudança de status não é permitida para este agendamento.");
  }
  const reopening = current === "canceled";
  if (reopening) {
    // reativar volta a ocupar o horário: confere de novo
    await lockOwners(tx, ctx, [existing.ownerId]);
    const conflicts = await conflictsFor(tx, ctx, existing.ownerId, existing.startsAt, existing.endsAt, id);
    if (conflicts.length) return fail("conflict", "O horário foi ocupado por outro agendamento. Remarque antes de reativar.");
  }
  try {
    await tx.transaction(async (sp) => {
      await sp.update(appointments).set({ status: next, allowConflict: reopening ? false : existing.allowConflict, updatedAt: now }).where(eq(appointments.id, id));
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) return fail("conflict", "O horário foi ocupado por outro agendamento. Remarque antes de reativar.");
    throw error;
  }
  if (next === "canceled" || next === "done") {
    await tx
      .update(appointmentReminders)
      .set({ status: "skipped" })
      .where(and(eq(appointmentReminders.appointmentId, id), eq(appointmentReminders.status, "scheduled")));
  } else if (reopening) {
    await rebuildReminders(tx, ctx, { id, startsAt: existing.startsAt, status: next }, now);
  }
  if (next === "canceled" || next === "done") {
    await recordContactEvent(tx, ctx.organizationId, existing.contactId, "appointment", next === "done" ? "Atendimento concluído" : "Agendamento cancelado");
  }
  const updated = await getAppointment(tx, ctx, id);
  if (!updated) throw new Error("agendamento atualizado não encontrado");
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok(updated);
}

/**
 * Resposta do cliente a um lembrete (Conversas chama quando chega mensagem de quem tem agendamento próximo).
 * Só age se "confirmar por resposta" estiver ligado; guarda a resposta como prova.
 */
export async function applyReminderReply(
  tx: Transaction,
  ctx: ServiceCtx,
  appointmentId: string,
  text: string,
  now = new Date(),
): Promise<Result<{ status: AppointmentStatus }, "not_found" | "ignored">> {
  const [existing] = await tx.select().from(appointments).where(and(inOrg(ctx), eq(appointments.id, appointmentId))).limit(1);
  if (!existing) return fail("not_found", "Agendamento não encontrado.");
  const settings = await getReminderSettings(tx, ctx);
  const reply = interpretReminderReply(text);
  if (!settings.confirmByReply || !reply) return fail("ignored", "A resposta não muda o agendamento.");
  const current = appointmentStatusSchema.catch("pending").parse(existing.status);
  const next = statusAfterReply(current, reply);
  if (next === current && existing.confirmationReply) return ok({ status: current });
  await tx.update(appointments).set({ status: next, confirmationReply: text.slice(0, 200), updatedAt: now }).where(eq(appointments.id, appointmentId));
  queueRealtime(tx, ctx.organizationId, { type: "home.invalidate" });
  return ok({ status: next });
}

// Tipos e responsáveis -----------------------------------------------------------------------------------------

function typeToDto(row: typeof appointmentTypes.$inferSelect): AppointmentType {
  return { id: row.id, name: row.name, durationMinutes: row.durationMinutes, active: row.active, staffOnly: row.staffOnly };
}

export async function listAppointmentTypes(tx: Transaction, ctx: ServiceCtx): Promise<AppointmentType[]> {
  const rows = await tx.select().from(appointmentTypes).where(eq(appointmentTypes.organizationId, ctx.organizationId)).orderBy(asc(appointmentTypes.createdAt), asc(appointmentTypes.id));
  return rows.map(typeToDto);
}

export async function createAppointmentType(tx: Transaction, ctx: ServiceCtx, input: AppointmentTypeInputData): Promise<Result<AppointmentType, "duplicate">> {
  const all = await tx.select({ name: appointmentTypes.name }).from(appointmentTypes).where(eq(appointmentTypes.organizationId, ctx.organizationId));
  if (all.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) return fail("duplicate", "Já existe um tipo com esse nome.");
  const [row] = await tx
    .insert(appointmentTypes)
    .values({ id: newId(), organizationId: ctx.organizationId, name: input.name, durationMinutes: input.durationMinutes, staffOnly: input.staffOnly ?? false })
    .returning();
  if (!row) throw new Error("tipo não gravado");
  return ok(typeToDto(row));
}

export async function setAppointmentTypeActive(tx: Transaction, ctx: ServiceCtx, id: string, active: boolean): Promise<Result<AppointmentType, "not_found">> {
  return updateAppointmentType(tx, ctx, id, { active });
}

/** Edita o tipo: ativo/inativo e "só a equipe marca" (`staffOnly`: a IA não oferece nem agenda). */
export async function updateAppointmentType(
  tx: Transaction,
  ctx: ServiceCtx,
  id: string,
  patch: { active?: boolean; staffOnly?: boolean },
): Promise<Result<AppointmentType, "not_found">> {
  const set: Partial<typeof appointmentTypes.$inferInsert> = {};
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.staffOnly !== undefined) set.staffOnly = patch.staffOnly;
  if (Object.keys(set).length === 0) {
    const [current] = await tx.select().from(appointmentTypes).where(and(eq(appointmentTypes.organizationId, ctx.organizationId), eq(appointmentTypes.id, id)));
    return current ? ok(typeToDto(current)) : fail("not_found", "Tipo não encontrado.");
  }
  const [row] = await tx
    .update(appointmentTypes)
    .set(set)
    .where(and(eq(appointmentTypes.organizationId, ctx.organizationId), eq(appointmentTypes.id, id)))
    .returning();
  return row ? ok(typeToDto(row)) : fail("not_found", "Tipo não encontrado.");
}

export async function listAgendaOwners(tx: Transaction, ctx: ServiceCtx): Promise<AgendaOwner[]> {
  return listOrgOwners(tx, ctx.organizationId);
}

// Lembretes: configurações --------------------------------------------------------------------------------------

export async function updateReminderSettings(tx: Transaction, ctx: ServiceCtx, settings: ReminderSettings, now = new Date()): Promise<Result<ReminderSettings, "invalid">> {
  const kinds = settings.reminders.map((r) => r.kind);
  if (new Set(kinds).size !== kinds.length) return fail("invalid", "Cada lembrete (24 h e 2 h) só pode aparecer uma vez.");
  for (const r of settings.reminders) {
    await tx
      .insert(appointmentReminderSettings)
      .values({ id: newId(), organizationId: ctx.organizationId, kind: r.kind, enabled: r.enabled, message: r.message, updatedAt: now })
      .onConflictDoUpdate({
        target: [appointmentReminderSettings.organizationId, appointmentReminderSettings.kind],
        set: { enabled: r.enabled, message: r.message, updatedAt: now },
      });
  }
  await tx
    .insert(agendaSettings)
    .values({ id: newId(), organizationId: ctx.organizationId, confirmByReply: settings.confirmByReply, updatedAt: now })
    .onConflictDoUpdate({ target: agendaSettings.organizationId, set: { confirmByReply: settings.confirmByReply, updatedAt: now } });
  return ok(await getReminderSettings(tx, ctx));
}

// Google Calendar (máquina de estados) ------------------------------------------------------------------------------

async function readSync(tx: Transaction, ctx: ServiceCtx): Promise<CalendarSync> {
  const [row] = await tx.select().from(calendarSyncs).where(eq(calendarSyncs.organizationId, ctx.organizationId)).limit(1);
  if (!row) return { ...DISCONNECTED_SYNC };
  return {
    status: row.status === "synced" || row.status === "syncing" || row.status === "error" ? row.status : "disconnected",
    calendarName: row.calendarName,
    accountEmail: row.accountEmail,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
  };
}

async function writeSync(tx: Transaction, ctx: ServiceCtx, state: CalendarSync, now: Date) {
  const values = {
    status: state.status,
    calendarName: state.calendarName,
    accountEmail: state.accountEmail,
    lastSyncedAt: state.lastSyncedAt ? new Date(state.lastSyncedAt) : null,
    errorMessage: state.errorMessage,
    updatedAt: now,
  };
  await tx
    .insert(calendarSyncs)
    .values({ id: newId(), organizationId: ctx.organizationId, ...values })
    .onConflictDoUpdate({ target: calendarSyncs.organizationId, set: values });
}

export async function getCalendarSync(tx: Transaction, ctx: ServiceCtx) {
  return readSync(tx, ctx);
}

/**
 * Conectar/desconectar. Sem OAuth nesta fase: "conectar" só registra o estado, com nomes provisórios
 * (a conta de quem clicou); o OAuth real preencherá agenda e e-mail do Google.
 */
export async function setCalendarConnected(tx: Transaction, ctx: ServiceCtx, connected: boolean, accountEmail: string | null, now = new Date()): Promise<CalendarSync> {
  const current = await readSync(tx, ctx);
  const next = nextSyncState(current, connected ? { type: "connect", calendarName: "Calendário principal", accountEmail } : { type: "disconnect" });
  if (!next) return current;
  await writeSync(tx, ctx, next, now);
  if (!connected) await tx.update(appointments).set({ syncedToGoogle: false }).where(and(inOrg(ctx), eq(appointments.syncedToGoogle, true)));
  return next;
}

/**
 * Sincronizar agora: `start` → chama a porta (fora da transação) → `succeeded`/`failed`. Desconectado não sincroniza.
 */
export async function syncCalendarNow(db: Database, ctx: ServiceCtx, port: CalendarPort, now = new Date()): Promise<Result<CalendarSync, "disconnected">> {
  const started = await withOrg(db, ctx.organizationId, async (tx) => {
    const current = await readSync(tx, ctx);
    if (current.status === "disconnected") return null;
    if (current.status === "syncing") return current; // já em andamento
    const next = nextSyncState(current, { type: "start" });
    if (next) await writeSync(tx, ctx, next, now);
    return next ?? current;
  });
  if (!started) return fail("disconnected", "Conecte o Google Calendar primeiro.");
  if (started.status !== "syncing") return ok(started);

  const outcome = await port.sync(ctx.organizationId).catch((): { ok: false; message: string } => ({ ok: false, message: "Não foi possível falar com o Google. Tente de novo." }));
  const finishedAt = new Date();
  return ok(
    await withOrg(db, ctx.organizationId, async (tx) => {
      const current = await readSync(tx, ctx);
      const next = nextSyncState(current, outcome.ok ? { type: "succeeded", at: finishedAt } : { type: "failed", message: outcome.message });
      if (!next) return current;
      await writeSync(tx, ctx, next, finishedAt);
      if (outcome.ok) await tx.update(appointments).set({ syncedToGoogle: true }).where(and(inOrg(ctx), ne(appointments.status, "canceled")));
      return next;
    }),
  );
}
