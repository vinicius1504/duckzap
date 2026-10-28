import type { BusinessHour } from "@duckzap/contracts/onboarding";
import { businessHoursSchema } from "@duckzap/contracts/settings";
import { describe, expect, it } from "vitest";
import { fromSettingsHours, toSettingsHours } from "./hours";

const week: BusinessHour[] = [
  { day: "mon", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "tue", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "wed", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "thu", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "fri", open: true, opensAt: "08:00", closesAt: "18:00" },
  { day: "sat", open: true, opensAt: "08:00", closesAt: "12:00" },
  { day: "sun", open: false, opensAt: "", closesAt: "" },
];

describe("horário do cadastro <-> Ajustes", () => {
  it("converte para o formato de Ajustes (0 = domingo) e passa no schema do contrato", () => {
    const converted = toSettingsHours(week);
    expect(businessHoursSchema.safeParse(converted).success).toBe(true);
    expect(converted.find((d) => d.day === 0)).toMatchObject({ open: false });
    expect(converted.find((d) => d.day === 6)).toMatchObject({ open: true, start: "08:00", end: "12:00" });
  });

  it("ida e volta preserva os dados", () => {
    expect(fromSettingsHours(toSettingsHours(week))).toEqual(week);
  });
});
