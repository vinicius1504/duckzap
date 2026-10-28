import { describe, expect, it } from "vitest";
import { dayRangeUtc, shiftDay, zonedDay, zonedTime, zonedToUtc } from "./time";

const SP = "America/Sao_Paulo"; // UTC−3 o ano todo (sem horário de verão desde 2019)

describe("dia + hora no fuso da empresa → UTC", () => {
  it("São Paulo: 09:00 local = 12:00Z, o ano inteiro", () => {
    expect(zonedToUtc("2025-01-15", "09:00", SP)).toBe("2025-01-15T12:00:00.000Z");
    expect(zonedToUtc("2025-07-15", "09:00", SP)).toBe("2025-07-15T12:00:00.000Z");
    expect(zonedToUtc("2025-11-02", "09:00", SP)).toBe("2025-11-02T12:00:00.000Z");
  });

  it("virada de dia no UTC: 22:30 local já é o dia seguinte em UTC", () => {
    expect(zonedToUtc("2025-03-31", "22:30", SP)).toBe("2025-04-01T01:30:00.000Z");
    expect(zonedToUtc("2025-12-31", "23:59", SP)).toBe("2026-01-01T02:59:00.000Z");
    expect(zonedToUtc("2025-06-10", "00:00", SP)).toBe("2025-06-10T03:00:00.000Z");
  });

  it("ida e volta: UTC → dia e hora locais", () => {
    expect(zonedDay("2025-04-01T01:30:00.000Z", SP)).toBe("2025-03-31");
    expect(zonedTime("2025-04-01T01:30:00.000Z", SP)).toBe("22:30");
    expect(zonedDay("2025-06-10T02:59:59.000Z", SP)).toBe("2025-06-09");
    expect(zonedDay("2025-06-10T03:00:00.000Z", SP)).toBe("2025-06-10");
  });

  it("UTC puro não desloca nada", () => {
    expect(zonedToUtc("2025-06-10", "23:30", "UTC")).toBe("2025-06-10T23:30:00.000Z");
    expect(zonedDay("2025-06-10T23:30:00.000Z", "UTC")).toBe("2025-06-10");
  });

  it("fuso com horário de verão é acertado pela segunda passada (referência: Nova York)", () => {
    expect(zonedToUtc("2025-01-15", "09:00", "America/New_York")).toBe("2025-01-15T14:00:00.000Z"); // EST −5
    expect(zonedToUtc("2025-07-15", "09:00", "America/New_York")).toBe("2025-07-15T13:00:00.000Z"); // EDT −4
  });
});

describe("intervalo de dias [from, to] → [início, fim) em UTC", () => {
  it("inclui o dia final inteiro e nada do dia seguinte", () => {
    const { start, end } = dayRangeUtc("2025-06-09", "2025-06-10", SP);
    expect(start.toISOString()).toBe("2025-06-09T03:00:00.000Z");
    expect(end.toISOString()).toBe("2025-06-11T03:00:00.000Z");
    // 23:30 do dia 10 em São Paulo (02:30Z do dia 11) ainda está dentro
    expect(new Date("2025-06-11T02:30:00Z") < end).toBe(true);
    expect(new Date("2025-06-11T03:00:00Z") < end).toBe(false);
  });

  it("shiftDay cruza mês e ano", () => {
    expect(shiftDay("2025-12-31", 1)).toBe("2026-01-01");
    expect(shiftDay("2025-03-01", -1)).toBe("2025-02-28");
  });
});
