import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizationId, tenantPolicy } from "./_tenant";
import { contacts } from "./contacts";

// Módulo Agenda. Ids: UUID v7 gerado pela aplicação. Datas: timestamptz em UTC (o fuso da empresa só na exibição
// e na conversão dia+hora → UTC feita pelo servidor). SQL cru (exclusão de conflito): appointments.sql.md.

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const appointmentTypes = pgTable(
  "appointment_types",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    name: text().notNull(),
    durationMinutes: integer().notNull(),
    active: boolean().notNull().default(true),
    /** Só a equipe marca (o agente de IA não oferece ao cliente). */
    staffOnly: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("appointment_types_org_idx").on(t.organizationId),
    uniqueIndex("appointment_types_org_name_unique").on(t.organizationId, sql`lower(${t.name})`),
    check("appointment_types_duration_check", sql`${t.durationMinutes} between 5 and 480`),
    tenantPolicy("appointment_types", t.organizationId),
  ],
).enableRLS();

export const appointments = pgTable(
  "appointments",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    typeId: uuid()
      .notNull()
      .references(() => appointmentTypes.id),
    /**
     * id do usuário responsável (Better Auth `user.id`). SEM FK de propósito: a coluna é NOT NULL (a restrição de
     * exclusão de conflito é por responsável) e o histórico fica; pessoas são desativadas, não apagadas.
     */
    ownerId: text().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default("pending"),
    source: text().notNull().default("manual"),
    sourceName: text(),
    notes: text(),
    confirmationReply: text(),
    /**
     * A pessoa viu o aviso de conflito e salvou mesmo assim. Essas linhas ficam fora da restrição de
     * exclusão (appointments.sql.md); todas as outras não podem se sobrepor no mesmo responsável.
     */
    allowConflict: boolean().notNull().default(false),
    syncedToGoogle: boolean().notNull().default(false),
    googleEventId: text(),
    createdBy: text(),
    createdAt: createdAt(),
    updatedAt: createdAt(),
  },
  (t) => [
    index("appointments_org_starts_idx").on(t.organizationId, t.startsAt),
    index("appointments_org_owner_starts_idx").on(t.organizationId, t.ownerId, t.startsAt),
    index("appointments_org_contact_idx").on(t.organizationId, t.contactId),
    index("appointments_contact_id_idx").on(t.contactId),
    index("appointments_type_id_idx").on(t.typeId),
    check("appointments_status_check", sql`${t.status} in ('pending','confirmed','reschedule','done','canceled')`),
    check("appointments_source_check", sql`${t.source} in ('manual','ai_agent','google')`),
    check("appointments_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    tenantPolicy("appointments", t.organizationId),
  ],
).enableRLS();

/** Lembretes gerados por agendamento (o envio é do worker; aqui só a agenda do que enviar). */
export const appointmentReminders = pgTable(
  "appointment_reminders",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    appointmentId: uuid()
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    scheduledFor: timestamp({ withTimezone: true }).notNull(),
    status: text().notNull().default("scheduled"),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("appointment_reminders_appt_kind_unique").on(t.appointmentId, t.kind),
    index("appointment_reminders_org_idx").on(t.organizationId),
    index("appointment_reminders_due_idx").on(t.status, t.scheduledFor),
    check("appointment_reminders_kind_check", sql`${t.kind} in ('24h','2h')`),
    check("appointment_reminders_status_check", sql`${t.status} in ('scheduled','sent','skipped')`),
    tenantPolicy("appointment_reminders", t.organizationId),
  ],
).enableRLS();

/** Mensagem e liga/desliga de cada lembrete (uma linha por tipo e empresa). */
export const appointmentReminderSettings = pgTable(
  "appointment_reminder_settings",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId(),
    kind: text().notNull(),
    enabled: boolean().notNull().default(true),
    message: text().notNull(),
    updatedAt: createdAt(),
  },
  (t) => [
    unique("appointment_reminder_settings_org_kind_unique").on(t.organizationId, t.kind),
    check("appointment_reminder_settings_kind_check", sql`${t.kind} in ('24h','2h')`),
    tenantPolicy("appointment_reminder_settings", t.organizationId),
  ],
).enableRLS();

/** Configurações gerais da agenda (uma linha por empresa). */
export const agendaSettings = pgTable(
  "agenda_settings",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId().unique(),
    /** A resposta do cliente ao lembrete muda o status (1/SIM → confirmado; 2/REMARCAR → a remarcar). */
    confirmByReply: boolean().notNull().default(true),
    updatedAt: createdAt(),
  },
  (t) => [tenantPolicy("agenda_settings", t.organizationId)],
).enableRLS();

/** Estado da sincronização com o Google Calendar (máquina de estados; sem OAuth nesta fase). */
export const calendarSyncs = pgTable(
  "calendar_syncs",
  {
    id: uuid().primaryKey(),
    organizationId: organizationId().unique(),
    status: text().notNull().default("disconnected"),
    calendarName: text(),
    accountEmail: text(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    errorMessage: text(),
    updatedAt: createdAt(),
  },
  (t) => [
    check("calendar_syncs_status_check", sql`${t.status} in ('synced','syncing','error','disconnected')`),
    tenantPolicy("calendar_syncs", t.organizationId),
  ],
).enableRLS();
