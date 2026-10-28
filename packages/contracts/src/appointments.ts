import { z } from "zod";

// Agenda: agendamentos, tipos de atendimento (com duração), responsáveis, conflito de horário,
// lembretes automáticos (24 h / 2 h, confirmação por resposta) e sincronização com o Google Calendar.

export const appointmentStatusSchema = z.enum(["pending", "confirmed", "reschedule", "done", "canceled"]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

export const appointmentTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  durationMinutes: z.number().int().min(5).max(480),
  active: z.boolean(),
  /** Só a equipe marca: o agente de IA não oferece nem agenda esse tipo (§4.2). */
  staffOnly: z.boolean(),
});
export type AppointmentType = z.infer<typeof appointmentTypeSchema>;

export const appointmentTypeInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome ao tipo.").max(60),
  durationMinutes: z.number().int().min(5, "Mínimo de 5 min.").max(480, "Máximo de 8 h."),
  /** Só a equipe marca; a IA não agenda. Opcional na entrada (padrão: a IA pode agendar). */
  staffOnly: z.boolean().default(false),
});
export type AppointmentTypeInput = z.input<typeof appointmentTypeInputSchema>;

/** Pessoa da equipe que atende (responsável pela agenda). */
export const agendaOwnerSchema = z.object({ id: z.string(), name: z.string() });
export type AgendaOwner = z.infer<typeof agendaOwnerSchema>;

export const reminderKindSchema = z.enum(["24h", "2h"]);
export type ReminderKind = z.infer<typeof reminderKindSchema>;

export const appointmentReminderSchema = z.object({
  kind: reminderKindSchema,
  status: z.enum(["scheduled", "sent", "skipped"]),
  at: z.iso.datetime(),
});
export type AppointmentReminder = z.infer<typeof appointmentReminderSchema>;

export const appointmentSchema = z.object({
  id: z.string(),
  contactId: z.string(),
  contactName: z.string(),
  contactPhone: z.string().nullable(),
  typeId: z.string(),
  ownerId: z.string(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: appointmentStatusSchema,
  notes: z.string().nullable(),
  /** Quem marcou: pessoa, agente de IA ou evento vindo do Google Calendar. */
  source: z.enum(["manual", "ai_agent", "google"]),
  sourceName: z.string().nullable(),
  reminders: z.array(appointmentReminderSchema),
  /** Resposta do cliente ao lembrete (ex.: "1", "Confirmo!"). */
  confirmationReply: z.string().nullable(),
  syncedToGoogle: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Appointment = z.infer<typeof appointmentSchema>;

export const appointmentRangeQuerySchema = z.object({
  /** Dias (inclusive) no fuso da organização. */
  from: z.iso.date(),
  to: z.iso.date(),
  ownerId: z.string().optional(),
  typeId: z.string().optional(),
});
export type AppointmentRangeQuery = z.infer<typeof appointmentRangeQuerySchema>;

export const appointmentInputSchema = z.object({
  contactId: z.string().min(1, "Escolha o cliente."),
  typeId: z.string().min(1, "Escolha o tipo de atendimento."),
  ownerId: z.string().min(1, "Escolha o responsável."),
  /** Dia e hora no fuso da organização; o servidor converte para UTC. */
  date: z.iso.date({ error: "Informe a data." }),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Informe a hora."),
  durationMinutes: z.number({ error: "Informe a duração." }).int().min(5, "A duração mínima é 5 min.").max(480, "A duração máxima é 8 h."),
  notes: z.string().trim().max(500),
  /** O usuário viu o aviso de conflito e quer salvar mesmo assim. */
  allowConflict: z.boolean(),
});
export type AppointmentInput = z.input<typeof appointmentInputSchema>;

export const conflictQuerySchema = z.object({
  ownerId: z.string().min(1),
  date: z.iso.date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(5).max(480),
  excludeId: z.string().nullable(),
});
export type ConflictQuery = z.input<typeof conflictQuerySchema>;

export const calendarSyncSchema = z.object({
  status: z.enum(["synced", "syncing", "error", "disconnected"]),
  calendarName: z.string().nullable(),
  accountEmail: z.string().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  errorMessage: z.string().nullable(),
});
export type CalendarSync = z.infer<typeof calendarSyncSchema>;

export const reminderSettingSchema = z.object({
  kind: reminderKindSchema,
  enabled: z.boolean(),
  message: z.string().trim().min(1, "Escreva a mensagem do lembrete.").max(500),
});
export type ReminderSetting = z.infer<typeof reminderSettingSchema>;

export const reminderSettingsSchema = z.object({
  reminders: z.array(reminderSettingSchema),
  /** Resposta do cliente muda o status (1/SIM → confirmado; 2/REMARCAR → a remarcar). */
  confirmByReply: z.boolean(),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;

/** Dois intervalos [início, fim) se sobrepõem. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string) {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/** Agendamentos que contam para conflito (cancelados e concluídos não ocupam horário futuro). */
export function blocksTime(status: AppointmentStatus) {
  return status !== "canceled";
}

/** Grupos de conflito: mesmo responsável com horários sobrepostos. Devolve os ids em conflito. */
export function findConflicts(appointments: readonly Pick<Appointment, "id" | "ownerId" | "startsAt" | "endsAt" | "status">[]) {
  const ids = new Set<string>();
  const active = appointments.filter((a) => blocksTime(a.status));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a && b && a.ownerId === b.ownerId && overlaps(a.startsAt, a.endsAt, b.startsAt, b.endsAt)) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}
