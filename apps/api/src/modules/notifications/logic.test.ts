import { describe, expect, it } from "vitest";
import { appointmentNotice, notificationRecipients } from "./logic";

describe("notificationRecipients", () => {
  it("equipe da conversa + responsável do agendamento, sem repetir", () => {
    expect(notificationRecipients({ teamMembers: ["a", "b"], owner: "c", admins: ["x"] })).toEqual(["a", "b", "c"]);
    expect(notificationRecipients({ teamMembers: ["a", "b"], owner: "b", admins: ["x"] })).toEqual(["a", "b"]);
  });

  it("equipe com gente ativa não chama proprietários e administradores", () => {
    expect(notificationRecipients({ teamMembers: ["a"], owner: null, admins: ["x", "y"] })).toEqual(["a"]);
  });

  it("sem equipe (ou equipe sem ninguém ativo) vai para proprietários e administradores, mais o responsável", () => {
    expect(notificationRecipients({ teamMembers: [], owner: "c", admins: ["x", "y"] })).toEqual(["x", "y", "c"]);
    expect(notificationRecipients({ teamMembers: [], owner: "x", admins: ["x", "y"] })).toEqual(["x", "y"]);
    expect(notificationRecipients({ teamMembers: [], owner: null, admins: [] })).toEqual([]);
  });

  it("ids repetidos na entrada viram um só", () => {
    expect(notificationRecipients({ teamMembers: ["a", "a"], owner: null, admins: [] })).toEqual(["a"]);
  });
});

describe("appointmentNotice", () => {
  // 29/10/2026 11:30 UTC = quinta-feira 08:30 em São Paulo
  const startsAt = new Date("2026-10-29T11:30:00Z");
  const base = { agentName: "Jacan", clientName: "Maria Souza", typeName: "Reunião de apresentação", startsAt, timeZone: "America/Sao_Paulo" } as const;

  it("marcou: título com o agente e corpo com cliente, tipo e horário no fuso da empresa", () => {
    expect(appointmentNotice({ ...base, kind: "appointment_booked" })).toEqual({
      title: "Jacan marcou um agendamento",
      body: "Maria Souza · Reunião de apresentação · quinta-feira, 29/10 às 08:30",
    });
  });

  it("marcou sem confirmar: acrescenta 'pendente de confirmação'", () => {
    expect(appointmentNotice({ ...base, kind: "appointment_booked", pending: true }).body).toBe(
      "Maria Souza · Reunião de apresentação · quinta-feira, 29/10 às 08:30 · pendente de confirmação",
    );
  });

  it("remarcou e cancelou usam o verbo certo; cancelar nunca diz 'pendente'", () => {
    expect(appointmentNotice({ ...base, kind: "appointment_rescheduled" }).title).toBe("Jacan remarcou um agendamento");
    const canceled = appointmentNotice({ ...base, kind: "appointment_canceled", pending: true });
    expect(canceled.title).toBe("Jacan cancelou um agendamento");
    expect(canceled.body).toBe("Maria Souza · Reunião de apresentação · quinta-feira, 29/10 às 08:30");
  });

  it("respeita o fuso da empresa (Manaus = UTC-4)", () => {
    expect(appointmentNotice({ ...base, kind: "appointment_booked", timeZone: "America/Manaus" }).body).toContain("às 07:30");
  });
});
