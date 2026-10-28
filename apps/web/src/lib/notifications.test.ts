import type { Notification, NotificationList } from "@duckzap/contracts/notifications";
import { describe, expect, it } from "vitest";
import { bellLabel, formatBadge, markRead, notificationIcon, reconcile, relativeTime, unreadAnnouncement } from "./notifications";

const TZ = "America/Sao_Paulo";
// 28/10/2026 15:00 em São Paulo (UTC-3)
const NOW = new Date("2026-10-28T18:00:00Z");

function item(id: string, read: boolean): Notification {
  return { id, kind: "appointment_booked", title: `t${id}`, body: "b", link: null, createdAt: "2026-10-28T17:00:00Z", read };
}
const list = (items: Notification[], unreadCount = items.filter((i) => !i.read).length): NotificationList => ({ items, unreadCount });

describe("formatBadge", () => {
  it("zero não mostra nada", () => {
    expect(formatBadge(0)).toBe("");
    expect(formatBadge(-3)).toBe("");
    expect(formatBadge(Number.NaN)).toBe("");
  });
  it("mostra o número até 99 e '99+' acima", () => {
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(99)).toBe("99");
    expect(formatBadge(100)).toBe("99+");
    expect(formatBadge(2500)).toBe("99+");
  });
});

describe("bellLabel / unreadAnnouncement", () => {
  it("concorda singular e plural", () => {
    expect(bellLabel(0)).toBe("Notificações");
    expect(bellLabel(1)).toBe("Notificações, 1 nova");
    expect(bellLabel(3)).toBe("Notificações, 3 novas");
    expect(bellLabel(150)).toBe("Notificações, 150 novas");
  });
  it("anuncia só quando há não lidas", () => {
    expect(unreadAnnouncement(0)).toBe("");
    expect(unreadAnnouncement(1)).toBe("1 notificação não lida");
    expect(unreadAnnouncement(4)).toBe("4 notificações não lidas");
  });
});

describe("notificationIcon", () => {
  it("um ícone por tipo", () => {
    expect(notificationIcon("appointment_booked")).toBe("calendar");
    expect(notificationIcon("appointment_rescheduled")).toBe("refresh");
    expect(notificationIcon("appointment_canceled")).toBe("close");
  });
});

describe("relativeTime", () => {
  const at = (iso: string) => relativeTime(iso, NOW, TZ);
  it("menos de um minuto (e relógio adiantado) é 'agora'", () => {
    expect(at("2026-10-28T17:59:30Z")).toBe("agora");
    expect(at("2026-10-28T18:05:00Z")).toBe("agora");
  });
  it("minutos e horas no mesmo dia", () => {
    expect(at("2026-10-28T17:55:00Z")).toBe("há 5 min");
    expect(at("2026-10-28T17:01:00Z")).toBe("há 59 min");
    expect(at("2026-10-28T16:00:00Z")).toBe("há 2 h");
  });
  it("ontem mostra a hora no fuso da empresa", () => {
    // 27/10 14:20 em São Paulo
    expect(at("2026-10-27T17:20:00Z")).toBe("ontem 14:20");
  });
  it("virada de dia usa o fuso, não o UTC", () => {
    // agora = 28/10 00:30 em SP (03:30 UTC). 01:00 UTC ainda é 28/10 em UTC, mas em SP foi ontem às 22:00
    const now = new Date("2026-10-28T03:30:00Z");
    expect(relativeTime("2026-10-28T01:00:00Z", now, TZ)).toBe("ontem 22:00");
    expect(relativeTime("2026-10-28T03:00:00Z", now, TZ)).toBe("há 30 min");
  });
  it("mais antigo mostra a data; outro ano inclui o ano", () => {
    expect(at("2026-10-20T12:00:00Z")).toBe("20/10 09:00");
    expect(at("2025-12-31T12:00:00Z")).toBe("31/12/2025");
  });
  it("data inválida e fuso desconhecido não quebram", () => {
    expect(at("nao-e-data")).toBe("");
    expect(relativeTime("2026-10-27T17:20:00Z", NOW, "Fuso/Inexistente")).toBe("ontem 14:20");
  });
});

describe("markRead", () => {
  it("marca por ids e desconta só as que estavam não lidas", () => {
    const l = list([item("a", false), item("b", true), item("c", false)], 5);
    const r = markRead(l, { ids: ["a", "b"] });
    expect(r.items.map((i) => i.read)).toEqual([true, true, false]);
    expect(r.unreadCount).toBe(4);
  });
  it("não deixa o contador ficar negativo", () => {
    expect(markRead(list([item("a", false)], 0), { ids: ["a"] }).unreadCount).toBe(0);
  });
  it("ids que não estão na lista não mudam nada (mesma referência)", () => {
    const l = list([item("a", false)]);
    expect(markRead(l, { ids: ["zzz"] })).toBe(l);
    expect(markRead(l, { ids: [] })).toBe(l);
  });
  it("all zera, inclusive as não lidas fora da lista carregada", () => {
    const r = markRead(list([item("a", false), item("b", true)], 40), { all: true });
    expect(r.items.every((i) => i.read)).toBe(true);
    expect(r.unreadCount).toBe(0);
  });
  it("não muta a lista original", () => {
    const l = list([item("a", false)]);
    markRead(l, { ids: ["a"] });
    expect(l.items[0]?.read).toBe(false);
    expect(l.unreadCount).toBe(1);
  });
});

describe("reconcile", () => {
  it("mantém como lidas as que ainda estão sendo gravadas, mesmo que o servidor devolva não lidas", () => {
    const fromServer = list([item("a", false), item("b", false)], 2);
    const r = reconcile(fromServer, { all: false, ids: new Set(["a"]) });
    expect(r.items.map((i) => i.read)).toEqual([true, false]);
    expect(r.unreadCount).toBe(1);
  });
  it("'marcar todas' em andamento zera tudo", () => {
    expect(reconcile(list([item("a", false)]), { all: true, ids: new Set() }).unreadCount).toBe(0);
  });
  it("sem nada pendente devolve a lista do servidor", () => {
    const fromServer = list([item("a", false)]);
    expect(reconcile(fromServer, { all: false, ids: new Set() })).toBe(fromServer);
  });
});
