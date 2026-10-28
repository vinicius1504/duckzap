import { randomInt } from "node:crypto";
import { createDb, withOrg, type Transaction } from "@duckzap/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { schema } from "@duckzap/db";
import { createContact } from "../contacts/service";
import type { ServiceCtx } from "../contacts/result";
import * as service from "./service";
import type { AppointmentInputData } from "./service";

// INTEGRAÇÃO — precisa do Postgres do Docker com a migration de Clientes e Agenda (e, para o último teste,
// a restrição de exclusão de appointments.sql.md) e o seed (org_alvorada/usr_marina/usr_rafael, org_lume).
// Liga com AGENDA_INTEGRATION=1 e DATABASE_URL (papel duckzap_app). Cada teste roda numa transação desfeita no fim.
try {
  process.loadEnvFile(".env");
} catch {
  // variáveis podem vir do ambiente (CI)
}
const enabled = process.env.AGENDA_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const db = enabled ? createDb(process.env.DATABASE_URL as string, { max: 2 }) : null;
afterAll(async () => db?.close());

const A: ServiceCtx = { organizationId: "org_alvorada", userId: "usr_marina", userName: "Marina Alves", timeZone: "America/Sao_Paulo", orgName: "Casa Alvorada Odontologia" };
const B: ServiceCtx = { organizationId: "org_lume", userId: "usr_lume", userName: "Lia Moraes", timeZone: "America/Sao_Paulo", orgName: "Studio Lume" };

async function rollback(fn: (tx: Transaction) => Promise<void>) {
  const marker = new Error("rollback");
  try {
    await withOrg(db!.db, A.organizationId, async (tx) => {
      await fn(tx);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

const actAs = (tx: Transaction, ctx: ServiceCtx) => tx.execute(sql`select set_config('app.org_id', ${ctx.organizationId}, true)`);

const mustOk = <T>(r: { ok: true; data: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message);
  return r.data;
};

async function fixtures(tx: Transaction) {
  const contact = mustOk(
    await createContact(tx, A, {
      name: "Paciente de Teste",
      phone: `+55679${randomInt(10_000_000, 99_999_999)}`,
      email: "",
      instagram: "",
      isCustomer: true,
      tagIds: [],
      origin: "customer",
      originNote: "",
      ownerId: null,
      birthDate: "",
    }),
  );
  const type = mustOk(await service.createAppointmentType(tx, A, { name: `Tipo ${randomInt(1e9)}`, durationMinutes: 30 }));
  return { contact, type };
}

const slot = (f: { contact: { id: string }; type: { id: string } }, over: Partial<AppointmentInputData> = {}): AppointmentInputData => ({
  contactId: f.contact.id,
  typeId: f.type.id,
  ownerId: "usr_marina",
  date: "2031-03-12",
  time: "09:00",
  durationMinutes: 30,
  notes: "",
  allowConflict: false,
  ...over,
});

describe.skipIf(!enabled)("Agenda — casos de uso (precisa da migration)", () => {
  it("cria no fuso da empresa (09:00 em São Paulo = 12:00Z), com lembretes 24 h e 2 h", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const now = new Date("2031-03-01T00:00:00Z");
      const created = mustOk(await service.createAppointment(tx, A, slot(f), {}, now));
      expect(created.startsAt).toBe("2031-03-12T12:00:00.000Z");
      expect(created.endsAt).toBe("2031-03-12T12:30:00.000Z");
      expect(created.status).toBe("pending");
      expect(created.sourceName).toBe("Marina Alves");
      expect(created.reminders.map((r) => [r.kind, r.at, r.status])).toEqual([
        ["24h", "2031-03-11T12:00:00.000Z", "scheduled"],
        ["2h", "2031-03-12T10:00:00.000Z", "scheduled"],
      ]);
      expect((await service.listAppointmentsForContact(tx, A, f.contact.id)).map((a) => a.id)).toEqual([created.id]);
    });
  });

  it("listAppointments usa o dia local: 23:30 de São Paulo (02:30Z do dia seguinte) fica no dia certo", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const late = mustOk(await service.createAppointment(tx, A, slot(f, { time: "23:30" })));
      expect(late.startsAt).toBe("2031-03-13T02:30:00.000Z");
      const day12 = await service.listAppointments(tx, A, { from: "2031-03-12", to: "2031-03-12" });
      const day13 = await service.listAppointments(tx, A, { from: "2031-03-13", to: "2031-03-13" });
      expect(day12.map((a) => a.id)).toContain(late.id);
      expect(day13.map((a) => a.id)).not.toContain(late.id);
    });
  });

  it("detecta conflito do mesmo responsável; encostar não conflita; outro responsável não conflita", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const first = mustOk(await service.createAppointment(tx, A, slot(f)));

      const clash = await service.createAppointment(tx, A, slot(f, { time: "09:15" }));
      expect(clash).toMatchObject({ ok: false, error: "conflict" });
      expect(clash.ok ? [] : (clash.conflicts ?? []).map((c) => c.id)).toEqual([first.id]);

      expect((await service.createAppointment(tx, A, slot(f, { time: "09:30" }))).ok).toBe(true); // encosta no fim
      expect((await service.createAppointment(tx, A, slot(f, { time: "09:00", ownerId: "usr_rafael" }))).ok).toBe(true);

      const found = await service.findAppointmentConflicts(tx, A, { ownerId: "usr_marina", date: "2031-03-12", time: "09:10", durationMinutes: 10, excludeId: null });
      expect(found.map((c) => c.id)).toEqual([first.id]);
      expect(await service.findAppointmentConflicts(tx, A, { ownerId: "usr_marina", date: "2031-03-12", time: "09:10", durationMinutes: 10, excludeId: first.id })).toEqual([]);
    });
  });

  it("'salvar mesmo assim' grava o conflito; cancelado libera o horário", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const first = mustOk(await service.createAppointment(tx, A, slot(f)));
      const forced = mustOk(await service.createAppointment(tx, A, slot(f, { time: "09:10", allowConflict: true })));
      expect(forced.id).not.toBe(first.id);

      mustOk(await service.setAppointmentStatus(tx, A, first.id, "canceled"));
      const retry = await service.createAppointment(tx, A, slot(f, { time: "09:00" }));
      expect(retry).toMatchObject({ ok: false, error: "conflict" }); // ainda bate com o forçado
      mustOk(await service.setAppointmentStatus(tx, A, forced.id, "canceled"));
      expect((await service.createAppointment(tx, A, slot(f, { time: "09:00" }))).ok).toBe(true);
    });
  });

  it("transições de status válidas e inválidas; cancelar ignora lembretes pendentes; reativar confere o horário", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const a = mustOk(await service.createAppointment(tx, A, slot(f), {}, new Date("2031-03-01T00:00:00Z")));
      expect(await service.setAppointmentStatus(tx, A, a.id, "done")).toMatchObject({ ok: false, error: "invalid_transition" });
      expect(mustOk(await service.setAppointmentStatus(tx, A, a.id, "confirmed")).status).toBe("confirmed");
      expect(mustOk(await service.setAppointmentStatus(tx, A, a.id, "reschedule")).status).toBe("reschedule");

      const canceled = mustOk(await service.setAppointmentStatus(tx, A, a.id, "canceled"));
      expect(canceled.reminders.every((r) => r.status === "skipped")).toBe(true);

      // alguém ocupa o horário; reativar agora conflita
      mustOk(await service.createAppointment(tx, A, slot(f)));
      expect(await service.setAppointmentStatus(tx, A, a.id, "pending")).toMatchObject({ ok: false, error: "conflict" });
      expect(await service.setAppointmentStatus(tx, A, "0190b3a0-0000-7000-8000-000000000001", "confirmed")).toMatchObject({ ok: false, error: "not_found" });
    });
  });

  it("remarcar volta para pendente, limpa a confirmação e refaz os lembretes", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const now = new Date("2031-03-01T00:00:00Z");
      const a = mustOk(await service.createAppointment(tx, A, slot(f), {}, now));
      mustOk(await service.setAppointmentStatus(tx, A, a.id, "confirmed"));
      const moved = mustOk(await service.updateAppointment(tx, A, a.id, slot(f, { date: "2031-03-14", time: "10:00" }), now));
      expect(moved.status).toBe("pending");
      expect(moved.startsAt).toBe("2031-03-14T13:00:00.000Z");
      expect(moved.reminders.map((r) => r.at)).toEqual(["2031-03-13T13:00:00.000Z", "2031-03-14T11:00:00.000Z"]);
      // mesma hora: editar só as notas não derruba o status
      mustOk(await service.setAppointmentStatus(tx, A, a.id, "confirmed"));
      const edited = mustOk(await service.updateAppointment(tx, A, a.id, slot(f, { date: "2031-03-14", time: "10:00", notes: "trazer exames" }), now));
      expect(edited.status).toBe("confirmed");
      expect(edited.notes).toBe("trazer exames");
    });
  });

  it("resposta ao lembrete: 1 confirma, 2 marca para remarcar, e só com a opção ligada", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const a = mustOk(await service.createAppointment(tx, A, slot(f)));
      expect(mustOk(await service.applyReminderReply(tx, A, a.id, "1")).status).toBe("confirmed");
      expect(mustOk(await service.applyReminderReply(tx, A, a.id, "2")).status).toBe("reschedule");
      expect(await service.applyReminderReply(tx, A, a.id, "bom dia")).toMatchObject({ ok: false, error: "ignored" });

      const settings = await service.getReminderSettings(tx, A);
      mustOk(await service.updateReminderSettings(tx, A, { ...settings, confirmByReply: false }));
      expect(await service.applyReminderReply(tx, A, a.id, "1")).toMatchObject({ ok: false, error: "ignored" });
    });
  });

  it("tipos: duplicado é recusado, desativar funciona; configurações de lembrete persistem", async () => {
    await rollback(async (tx) => {
      const type = mustOk(await service.createAppointmentType(tx, A, { name: "Clareamento X", durationMinutes: 60 }));
      expect(await service.createAppointmentType(tx, A, { name: "clareamento x", durationMinutes: 30 })).toMatchObject({ ok: false, error: "duplicate" });
      expect(mustOk(await service.setAppointmentTypeActive(tx, A, type.id, false)).active).toBe(false);

      const before = await service.getReminderSettings(tx, A);
      expect(before.reminders.map((r) => r.kind)).toEqual(["24h", "2h"]);
      const saved = mustOk(await service.updateReminderSettings(tx, A, { confirmByReply: false, reminders: [{ kind: "2h", enabled: false, message: "Até já!" }] }));
      expect(saved.reminders.find((r) => r.kind === "2h")).toMatchObject({ enabled: false, message: "Até já!" });
      expect(saved.confirmByReply).toBe(false);
      expect(await service.updateReminderSettings(tx, A, { confirmByReply: true, reminders: [{ kind: "2h", enabled: true, message: "a" }, { kind: "2h", enabled: true, message: "b" }] })).toMatchObject({ ok: false, error: "invalid" });
    });
  });

  it("Google Calendar: desconectado não sincroniza; conectar → sincronizar → estado sincronizado", async () => {
    await rollback(async (tx) => {
      expect((await service.getCalendarSync(tx, A)).status).toBe("disconnected");
      const connected = await service.setCalendarConnected(tx, A, true, "agenda@exemplo.com");
      expect(connected).toMatchObject({ status: "synced", accountEmail: "agenda@exemplo.com" });
      expect(await service.setCalendarConnected(tx, A, false, null)).toMatchObject({ status: "disconnected", accountEmail: null });
    });
  });

  it("outra empresa não vê nem altera agendamentos, tipos e contatos de A", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const a = mustOk(await service.createAppointment(tx, A, slot(f)));

      await actAs(tx, B);
      expect(await service.getAppointment(tx, B, a.id)).toBeNull();
      expect(await service.listAppointments(tx, B, { from: "2031-03-01", to: "2031-03-31" })).toEqual([]);
      expect(await service.listAppointmentsForContact(tx, B, f.contact.id)).toEqual([]);
      expect(await service.listAppointmentTypes(tx, B)).not.toContainEqual(expect.objectContaining({ id: f.type.id }));
      expect(await service.setAppointmentStatus(tx, B, a.id, "confirmed")).toMatchObject({ ok: false, error: "not_found" });
      expect(await service.updateAppointment(tx, B, a.id, slot(f), new Date())).toMatchObject({ ok: false, error: "not_found" });
      // tentar agendar na empresa B com cliente/tipo de A: referências "não existem" para B
      expect(await service.createAppointment(tx, B, slot(f, { ownerId: "usr_lume" }))).toMatchObject({ ok: false, error: "invalid" });
      expect(await service.setAppointmentTypeActive(tx, B, f.type.id, false)).toMatchObject({ ok: false, error: "not_found" });
    });
  });

  it("responsável precisa ser da equipe da empresa", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      expect(await service.createAppointment(tx, A, slot(f, { ownerId: "usr_lume" }))).toMatchObject({ ok: false, error: "invalid" });
    });
  });

  it("excluir o cliente (LGPD) leva os agendamentos e lembretes junto", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const a = mustOk(await service.createAppointment(tx, A, slot(f)));
      await tx.delete(schema.contacts).where(eq(schema.contacts.id, f.contact.id));
      expect(await service.getAppointment(tx, A, a.id)).toBeNull();
      expect(await tx.select().from(schema.appointmentReminders).where(eq(schema.appointmentReminders.appointmentId, a.id))).toEqual([]);
    });
  });
});

// Exige a restrição de exclusão (appointments.sql.md): garante que dois agendamentos "normais" nunca se sobrepõem,
// mesmo se a checagem do service for burlada (ex.: gravação direta).
describe.skipIf(!enabled || process.env.AGENDA_EXCLUSION_CONSTRAINT !== "1")("Agenda — restrição de exclusão no banco", () => {
  it("o banco recusa sobreposição sem allow_conflict e aceita com allow_conflict", async () => {
    await rollback(async (tx) => {
      const f = await fixtures(tx);
      const first = mustOk(await service.createAppointment(tx, A, slot(f)));
      const base = {
        organizationId: A.organizationId,
        contactId: f.contact.id,
        typeId: f.type.id,
        ownerId: "usr_marina",
        startsAt: new Date(first.startsAt),
        endsAt: new Date(first.endsAt),
      };
      let code: string | undefined;
      try {
        await tx.transaction(async (sp) => {
          await sp.insert(schema.appointments).values({ id: "0190b3a0-0000-7000-8000-0000000000aa", ...base });
        });
      } catch (error) {
        code = (error as { cause?: { code?: string } }).cause?.code;
      }
      expect(code).toBe("23P01");
      await tx.insert(schema.appointments).values({ id: "0190b3a0-0000-7000-8000-0000000000ab", ...base, allowConflict: true });
    });
  });
});
