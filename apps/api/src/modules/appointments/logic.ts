import type { AppointmentStatus, CalendarSync, ReminderKind, ReminderSettings } from "@duckzap/contracts/appointments";

// Regras puras da Agenda: transições de status, lembretes, resposta ao lembrete e a máquina de estados do Google Calendar.

/** Transições permitidas (as mesmas ações que a tela oferece em `statusActions`). */
export const STATUS_TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  pending: ["confirmed", "reschedule", "canceled"],
  confirmed: ["done", "reschedule", "canceled"],
  reschedule: ["confirmed", "canceled"],
  done: ["confirmed"],
  canceled: ["pending"],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus) {
  return STATUS_TRANSITIONS[from].includes(to);
}

// Lembretes ----------------------------------------------------------------------------------------------------

export const REMINDER_OFFSET_HOURS: Record<ReminderKind, number> = { "24h": 24, "2h": 2 };

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  reminders: [
    {
      kind: "24h",
      enabled: true,
      message: "Oi, {nome}! Passando para lembrar do seu horário amanhã às {hora}. Responda 1 para confirmar ou 2 para remarcar.",
    },
    { kind: "2h", enabled: true, message: "{nome}, seu horário é hoje às {hora}. Até já! Se não puder vir, responda 2." },
  ],
  confirmByReply: true,
};

export type PlannedReminder = { kind: ReminderKind; at: Date; status: "scheduled" | "skipped" };

/**
 * Lembretes de um agendamento: um por tipo ligado nas configurações, no horário (início − 24 h / − 2 h).
 * Cancelado/concluído, ou horário de lembrete que já passou, nasce `skipped`; o resto fica `scheduled`.
 */
export function computeReminders(
  appointment: { startsAt: Date; status: AppointmentStatus },
  settings: Pick<ReminderSettings, "reminders">,
  now: Date,
): PlannedReminder[] {
  const closed = appointment.status === "canceled" || appointment.status === "done";
  return settings.reminders
    .filter((r) => r.enabled)
    .map((r): PlannedReminder => {
      const at = new Date(appointment.startsAt.getTime() - REMINDER_OFFSET_HOURS[r.kind] * 3_600_000);
      return { kind: r.kind, at, status: closed || at.getTime() <= now.getTime() ? "skipped" : "scheduled" };
    })
    .sort((a, b) => REMINDER_OFFSET_HOURS[b.kind] - REMINDER_OFFSET_HOURS[a.kind]);
}

export type ReminderReply = "confirmed" | "reschedule";

/** Resposta ao lembrete: 1/SIM → confirmado; 2/REMARCAR → a remarcar. Qualquer outra coisa não muda nada. */
export function interpretReminderReply(text: string): ReminderReply | null {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 6) return null;
  const first = words[0];
  const negative = words.includes("nao");
  if (first === "2" || ["remarcar", "remarco", "remarca", "reagendar"].includes(first ?? "")) return "reschedule";
  if (negative && words.some((w) => ["posso", "vou", "consigo", "da"].includes(w))) return "reschedule";
  if (negative) return null;
  if (first === "1" || ["sim", "confirmo", "confirmado", "confirmada", "confirmar"].includes(first ?? "")) return "confirmed";
  return null;
}

/** Novo status do agendamento diante da resposta (só mexe em pendente/confirmado/a remarcar). */
export function statusAfterReply(current: AppointmentStatus, reply: ReminderReply): AppointmentStatus {
  if (current === "done" || current === "canceled") return current;
  return reply;
}

// Google Calendar (máquina de estados; sem OAuth nesta fase) ----------------------------------------------------

export type SyncEvent =
  | { type: "connect"; calendarName: string; accountEmail: string | null }
  | { type: "disconnect" }
  | { type: "start" }
  | { type: "succeeded"; at: Date }
  | { type: "failed"; message: string };

export const DISCONNECTED_SYNC: CalendarSync = {
  status: "disconnected",
  calendarName: null,
  accountEmail: null,
  lastSyncedAt: null,
  errorMessage: null,
};

/** Próximo estado, ou `null` se o evento não vale no estado atual (ex.: sincronizar desconectado). */
export function nextSyncState(current: CalendarSync, event: SyncEvent): CalendarSync | null {
  switch (event.type) {
    case "connect":
      return { ...current, status: "synced", calendarName: event.calendarName, accountEmail: event.accountEmail, errorMessage: null };
    case "disconnect":
      return { ...DISCONNECTED_SYNC, lastSyncedAt: current.lastSyncedAt };
    case "start":
      return current.status === "synced" || current.status === "error" ? { ...current, status: "syncing", errorMessage: null } : null;
    case "succeeded":
      return current.status === "syncing" ? { ...current, status: "synced", lastSyncedAt: event.at.toISOString(), errorMessage: null } : null;
    case "failed":
      return current.status === "syncing" ? { ...current, status: "error", errorMessage: event.message } : null;
  }
}
