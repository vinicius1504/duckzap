import { describe, expect, it } from "vitest";
import { ageLabel, assigneeLabel, distributePercent, dueLabel, lastDays, percentOf, periodRange } from "./logic";

const TZ = "America/Sao_Paulo";
// 26/10/2026 14:00 em São Paulo (UTC-3)
const now = new Date("2026-10-26T17:00:00Z");

describe("período", () => {
  it("hoje = desde 00:00 local até o fim do dia", () => {
    const r = periodRange("today", now, TZ);
    expect(r.from.toISOString()).toBe("2026-10-26T03:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-27T03:00:00.000Z");
    expect(r.days).toBe(1);
  });
  it("7 dias inclui hoje", () => {
    const r = periodRange("7d", now, TZ);
    expect(r.fromDay).toBe("2026-10-20");
    expect(r.toDay).toBe("2026-10-26");
  });
  it("30 dias, e 'custom' (sem seletor ainda) vale 30", () => {
    expect(periodRange("30d", now, TZ).fromDay).toBe("2026-09-27");
    expect(periodRange("custom", now, TZ).days).toBe(30);
  });
  it("o dia local manda: 23h30 de São Paulo ainda é hoje", () => {
    const late = new Date("2026-10-27T02:30:00Z");
    expect(periodRange("today", late, TZ).fromDay).toBe("2026-10-26");
  });
  it("últimos dias, do mais antigo ao mais novo", () => {
    expect(lastDays(3, now, TZ)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  });
});

describe("percentuais", () => {
  it("somam exatamente 100", () => {
    for (const counts of [[1, 1, 1], [3, 3, 3, 1], [5, 0, 0, 0], [7, 11, 13, 17], [1, 2]]) {
      expect(distributePercent(counts).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });
  it("sem dados, tudo zero", () => {
    expect(distributePercent([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });
  it("proporcional", () => {
    expect(distributePercent([35, 30, 20, 15])).toEqual([35, 30, 20, 15]);
  });
  it("percentOf nunca divide por zero", () => {
    expect(percentOf(1, 0)).toBe(0);
    expect(percentOf(2, 3)).toBe(67);
  });
});

describe("rótulo de prazo da tarefa", () => {
  const at = (iso: string) => new Date(iso);
  it("sem prazo", () => {
    expect(dueLabel({ dueAt: null, done: false, doneAt: null }, now, TZ)).toBe("Sem prazo");
  });
  it("hoje, amanhã e dia da semana", () => {
    expect(dueLabel({ dueAt: at("2026-10-26T19:00:00Z"), done: false, doneAt: null }, now, TZ)).toBe("Hoje, 16h");
    expect(dueLabel({ dueAt: at("2026-10-27T13:30:00Z"), done: false, doneAt: null }, now, TZ)).toBe("Amanhã, 10h30");
    expect(dueLabel({ dueAt: at("2026-10-30T17:00:00Z"), done: false, doneAt: null }, now, TZ)).toBe("Sexta, 14h");
  });
  it("atrasada e distante", () => {
    expect(dueLabel({ dueAt: at("2026-10-25T17:00:00Z"), done: false, doneAt: null }, now, TZ)).toBe("Atrasada · 25/10");
    expect(dueLabel({ dueAt: at("2026-11-20T17:00:00Z"), done: false, doneAt: null }, now, TZ)).toBe("20/11, 14h");
  });
  it("concluída", () => {
    expect(dueLabel({ dueAt: null, done: true, doneAt: at("2026-10-26T13:00:00Z") }, now, TZ)).toBe("Concluída hoje");
    expect(dueLabel({ dueAt: null, done: true, doneAt: at("2026-10-20T13:00:00Z") }, now, TZ)).toBe("Concluída");
  });
});

describe("textos", () => {
  it("responsável: 'Você' ou primeiro nome", () => {
    expect(assigneeLabel("u1", "u1", "Marina Alves")).toBe("Você");
    expect(assigneeLabel("u2", "u1", "Rafael Costa")).toBe("Rafael");
    expect(assigneeLabel("u2", "u1", null)).toBe("Equipe");
  });
  it("idade da espera", () => {
    expect(ageLabel(new Date(now.getTime() - 18 * 60_000), now)).toBe("18 min");
    expect(ageLabel(new Date(now.getTime() - 3 * 3_600_000), now)).toBe("3 h");
    expect(ageLabel(new Date(now.getTime() - 72 * 3_600_000), now)).toBe("3 dias");
  });
});
