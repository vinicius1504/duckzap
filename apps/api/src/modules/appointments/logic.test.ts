import { findConflicts, overlaps, type AppointmentStatus, type CalendarSync } from "@duckzap/contracts/appointments";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMINDER_SETTINGS,
  DISCONNECTED_SYNC,
  STATUS_TRANSITIONS,
  canTransition,
  computeReminders,
  interpretReminderReply,
  nextSyncState,
  statusAfterReply,
} from "./logic";

describe("sobreposição de horários (regra usada no banco e na tela)", () => {
  const t = (hhmm: string) => `2025-06-10T${hhmm}:00.000Z`;
  it("intervalos são [início, fim): encostar não é conflito", () => {
    expect(overlaps(t("12:00"), t("12:30"), t("12:30"), t("13:00"))).toBe(false);
    expect(overlaps(t("12:00"), t("12:30"), t("12:29"), t("13:00"))).toBe(true);
    expect(overlaps(t("12:00"), t("14:00"), t("12:30"), t("13:00"))).toBe(true); // um dentro do outro
  });
  it("só conflita com o mesmo responsável e ignora cancelados", () => {
    const base = { startsAt: t("12:00"), endsAt: t("13:00") };
    const list = [
      { id: "a", ownerId: "u1", status: "pending" as AppointmentStatus, ...base },
      { id: "b", ownerId: "u1", status: "confirmed" as AppointmentStatus, startsAt: t("12:30"), endsAt: t("13:30") },
      { id: "c", ownerId: "u2", status: "pending" as AppointmentStatus, ...base },
      { id: "d", ownerId: "u1", status: "canceled" as AppointmentStatus, ...base },
    ];
    expect([...findConflicts(list)].sort()).toEqual(["a", "b"]);
  });
});

describe("transições de status", () => {
  it("espelha as ações da tela", () => {
    expect(STATUS_TRANSITIONS.pending).toEqual(["confirmed", "reschedule", "canceled"]);
    expect(canTransition("confirmed", "done")).toBe(true);
    expect(canTransition("reschedule", "confirmed")).toBe(true);
    expect(canTransition("done", "confirmed")).toBe(true); // reabrir
    expect(canTransition("canceled", "pending")).toBe(true); // reativar
  });
  it("barra saltos inválidos", () => {
    expect(canTransition("pending", "done")).toBe(false);
    expect(canTransition("canceled", "done")).toBe(false);
    expect(canTransition("done", "canceled")).toBe(false);
    expect(canTransition("pending", "pending")).toBe(false);
  });
});

describe("computeReminders", () => {
  const settings = DEFAULT_REMINDER_SETTINGS;
  const startsAt = new Date("2025-06-10T15:00:00Z");

  it("24 h e 2 h antes do início, ambos agendados", () => {
    const r = computeReminders({ startsAt, status: "pending" }, settings, new Date("2025-06-01T00:00:00Z"));
    expect(r).toEqual([
      { kind: "24h", at: new Date("2025-06-09T15:00:00Z"), status: "scheduled" },
      { kind: "2h", at: new Date("2025-06-10T13:00:00Z"), status: "scheduled" },
    ]);
  });
  it("lembrete cujo horário já passou nasce ignorado", () => {
    const r = computeReminders({ startsAt, status: "pending" }, settings, new Date("2025-06-10T10:00:00Z"));
    expect(r.map((x) => [x.kind, x.status])).toEqual([
      ["24h", "skipped"],
      ["2h", "scheduled"],
    ]);
  });
  it("respeita o liga/desliga de cada lembrete", () => {
    const off = { reminders: [{ kind: "24h" as const, enabled: false, message: "x" }, { kind: "2h" as const, enabled: true, message: "y" }] };
    expect(computeReminders({ startsAt, status: "pending" }, off, new Date("2025-06-01T00:00:00Z")).map((x) => x.kind)).toEqual(["2h"]);
  });
  it("cancelado ou concluído não agenda lembrete", () => {
    for (const status of ["canceled", "done"] as const) {
      expect(computeReminders({ startsAt, status }, settings, new Date("2025-06-01T00:00:00Z")).every((r) => r.status === "skipped")).toBe(true);
    }
  });
});

describe("resposta ao lembrete (1/SIM e 2/REMARCAR)", () => {
  it.each(["1", "SIM", "sim", "Confirmo!", "confirmado"])("%s → confirmed", (t) => expect(interpretReminderReply(t)).toBe("confirmed"));
  it.each(["2", "REMARCAR", "não posso", "nao vou conseguir"])("%s → reschedule", (t) => expect(interpretReminderReply(t)).toBe("reschedule"));
  it.each(["", "bom dia", "não", "3", "sim mas não sei se consigo chegar a tempo amanhã de manhã"])("%j → sem efeito", (t) =>
    expect(interpretReminderReply(t)).toBeNull(),
  );
  it("não altera concluído nem cancelado", () => {
    expect(statusAfterReply("pending", "confirmed")).toBe("confirmed");
    expect(statusAfterReply("confirmed", "reschedule")).toBe("reschedule");
    expect(statusAfterReply("done", "confirmed")).toBe("done");
    expect(statusAfterReply("canceled", "reschedule")).toBe("canceled");
  });
});

describe("Google Calendar: máquina de estados", () => {
  const must = <T,>(value: T | null): T => {
    if (value === null) throw new Error("transição inválida");
    return value;
  };
  const connected: CalendarSync = { status: "synced", calendarName: "Agenda", accountEmail: "a@b.com", lastSyncedAt: null, errorMessage: null };
  it("conectar → sincronizar → sucesso", () => {
    const c = must(nextSyncState(DISCONNECTED_SYNC, { type: "connect", calendarName: "Agenda", accountEmail: "a@b.com" }));
    expect(c.status).toBe("synced");
    const s = must(nextSyncState(c, { type: "start" }));
    expect(s.status).toBe("syncing");
    const done = nextSyncState(s, { type: "succeeded", at: new Date("2025-06-10T12:00:00Z") });
    expect(done).toMatchObject({ status: "synced", lastSyncedAt: "2025-06-10T12:00:00.000Z", errorMessage: null });
  });
  it("falha vai para error e permite tentar de novo", () => {
    const failed = must(nextSyncState({ ...connected, status: "syncing" }, { type: "failed", message: "Token expirado" }));
    expect(failed).toMatchObject({ status: "error", errorMessage: "Token expirado" });
    expect(nextSyncState(failed, { type: "start" })?.status).toBe("syncing");
  });
  it("desconectado não sincroniza; sucesso/falha só valem durante a sincronização", () => {
    expect(nextSyncState(DISCONNECTED_SYNC, { type: "start" })).toBeNull();
    expect(nextSyncState(connected, { type: "succeeded", at: new Date() })).toBeNull();
    expect(nextSyncState(connected, { type: "failed", message: "x" })).toBeNull();
  });
  it("desconectar limpa a conta mas mantém a última sincronização", () => {
    const last = "2025-06-10T12:00:00.000Z";
    expect(nextSyncState({ ...connected, lastSyncedAt: last }, { type: "disconnect" })).toEqual({ ...DISCONNECTED_SYNC, lastSyncedAt: last });
  });
});
