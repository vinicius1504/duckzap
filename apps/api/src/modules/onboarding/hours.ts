import type { BusinessHour } from "@duckzap/contracts/onboarding";
import type { BusinessHours } from "@duckzap/contracts/settings";

/** O cadastro usa dias por nome (mon…sun); Ajustes usa 0 = domingo … 6 = sábado. Mesma informação, dois formatos. */
const dayNumber: Record<BusinessHour["day"], 0 | 1 | 2 | 3 | 4 | 5 | 6> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const dayName = Object.fromEntries(Object.entries(dayNumber).map(([name, n]) => [n, name])) as Record<number, BusinessHour["day"]>;

/** Ordem em que a tela de Ajustes mostra os dias: segunda a domingo. */
const settingsOrder = [1, 2, 3, 4, 5, 6, 0] as const;

export function toSettingsHours(hours: BusinessHour[]): BusinessHours {
  const byDay = new Map(hours.map((h) => [dayNumber[h.day], h]));
  return settingsOrder.map((day) => {
    const h = byDay.get(day);
    return h?.open
      ? { day, open: true, start: h.opensAt, end: h.closesAt }
      : { day, open: false, start: h?.opensAt || "08:00", end: h?.closesAt || "12:00" };
  });
}

export function fromSettingsHours(hours: BusinessHours): BusinessHour[] {
  const byDay = new Map(hours.map((h) => [h.day, h]));
  return (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => {
    const h = byDay.get(dayNumber[day]);
    return h?.open ? { day, open: true, opensAt: h.start, closesAt: h.end } : { day, open: false, opensAt: "", closesAt: "" };
  });
}

export { dayName };
