import { inviteIneligibility, type Contact } from "@duckzap/contracts/contacts";
import { describe, expect, it } from "vitest";
import { assignToDays, planInvites } from "./invite-plan";
import { channelDailyLimit, createInMemoryPorts } from "./ports";

const consent = (status: "pending" | "granted" | "denied" | "expired"): Contact["consent"] => ({
  status,
  method: "invite",
  updatedAt: "2025-06-01T12:00:00.000Z",
  inviteSentAt: null,
  inviteText: null,
  replyText: null,
  repliedAt: null,
  channelName: null,
});

describe("elegibilidade do convite (§5.7 item 7)", () => {
  it("origem legítima + telefone + sem convite anterior → elegível", () => {
    for (const origin of ["customer", "service", "form", "walk_in", "event", "referral"] as const) {
      expect(inviteIneligibility({ consent: null, origin, phone: "+5567999990000" })).toBeNull();
    }
  });
  it("sem origem, inbound ou sem telefone → não", () => {
    expect(inviteIneligibility({ consent: null, origin: null, phone: "+5567999990000" })).toBe("no_origin");
    expect(inviteIneligibility({ consent: null, origin: "inbound", phone: "+5567999990000" })).toBe("inbound");
    expect(inviteIneligibility({ consent: null, origin: "form", phone: null })).toBe("no_phone");
  });
  it("um convite só, para sempre: qualquer consent anterior bloqueia (inclusive expirado)", () => {
    expect(inviteIneligibility({ consent: consent("pending"), origin: "form", phone: "+5567999990000" })).toBe("already_invited");
    expect(inviteIneligibility({ consent: consent("expired"), origin: "form", phone: "+5567999990000" })).toBe("already_invited");
    expect(inviteIneligibility({ consent: consent("granted"), origin: "form", phone: "+5567999990000" })).toBe("has_consent");
    expect(inviteIneligibility({ consent: consent("denied"), origin: "form", phone: "+5567999990000" })).toBe("has_consent");
  });
});

describe("planInvites (limites por número, divisão em dias)", () => {
  const base = { invitesSentToday: 0, messagesSentToday: 0, inviteDailyLimit: 20, channelDailyLimit: 50, today: "2025-06-16", skipSundays: true };

  it("34 convites com limite de 20/dia → 20 hoje + 14 amanhã", () => {
    const plan = planInvites({ ...base, count: 34 });
    expect(plan.days).toEqual([20, 14]);
    expect(plan.schedule).toEqual([
      { date: "2025-06-16", count: 20 },
      { date: "2025-06-17", count: 14 },
    ]);
  });

  it("desconta o que já saiu hoje (convites e o teto de mensagens do canal)", () => {
    expect(planInvites({ ...base, count: 10, invitesSentToday: 15 }).days).toEqual([5, 5]);
    // canal já mandou 45 de 50: só cabem 5 hoje, mesmo com cota de convites sobrando
    expect(planInvites({ ...base, count: 10, messagesSentToday: 45 }).days).toEqual([5, 5]);
  });

  it("hoje esgotado: nada hoje, começa amanhã", () => {
    const plan = planInvites({ ...base, count: 5, invitesSentToday: 20 });
    expect(plan.days).toEqual([0, 5]);
    expect(plan.schedule).toEqual([{ date: "2025-06-17", count: 5 }]);
  });

  it("número em aquecimento respeita o teto menor do canal", () => {
    const plan = planInvites({ ...base, count: 25, channelDailyLimit: channelDailyLimit(2) });
    expect(plan.dailyLimit).toBe(10);
    expect(plan.days).toEqual([10, 10, 5]);
  });

  it("pula domingos: sexta → sábado → segunda", () => {
    const plan = planInvites({ ...base, count: 60, today: "2025-06-20" }); // sexta
    expect(plan.schedule.map((d) => d.date)).toEqual(["2025-06-20", "2025-06-21", "2025-06-23"]);
  });

  it("hoje é domingo: começa na segunda com o limite cheio", () => {
    const plan = planInvites({ ...base, count: 30, today: "2025-06-22", invitesSentToday: 20 });
    expect(plan.schedule).toEqual([
      { date: "2025-06-23", count: 20 },
      { date: "2025-06-24", count: 10 },
    ]);
  });

  it("limite zero não agenda nada", () => {
    expect(planInvites({ ...base, count: 5, channelDailyLimit: 0 }).schedule).toEqual([]);
  });

  it("assignToDays reparte na ordem recebida", () => {
    const plan = planInvites({ ...base, count: 5, inviteDailyLimit: 3 });
    expect(assignToDays(["a", "b", "c", "d", "e"], plan.schedule)).toEqual([
      { date: "2025-06-16", items: ["a", "b", "c"] },
      { date: "2025-06-17", items: ["d", "e"] },
    ]);
  });
});

describe("portas em memória", () => {
  it("a fila só guarda os jobs e o diretório devolve os canais informados", async () => {
    const mem = createInMemoryPorts([{ id: "ch1", name: "Recepção", provider: "qr", connected: true, messagesSentToday: 3, warmupDay: null }]);
    expect(await mem.ports.channels.listInviteChannels("org")).toHaveLength(1);
    await mem.ports.queue.enqueueInvites([{ organizationId: "org", contactId: "c", channelId: "ch1", to: "+5567999990000", text: "oi", runOn: "2025-06-16" }]);
    expect(mem.jobs).toHaveLength(1);
  });
  it("sem canais conectados por padrão", async () => {
    expect(await createInMemoryPorts().ports.channels.listInviteChannels("org")).toEqual([]);
  });
});
