import type { BusinessHours, DayHours, Weekday } from "@duckzap/contracts/settings";

/** Ordem de exibição: segunda primeiro. */
export const weekOrder: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export const dayShort: Record<Weekday, string> = { 0: "Dom", 1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sáb" };
export const dayLong: Record<Weekday, string> = {
  0: "domingo",
  1: "segunda",
  2: "terça",
  3: "quarta",
  4: "quinta",
  5: "sexta",
  6: "sábado",
};

const sameHours = (a: DayHours, b: DayHours) => a.open === b.open && (!a.open || (a.start === b.start && a.end === b.end));

/** Agrupa dias seguidos com o mesmo horário: [{ label: "Seg–Sex", text: "08:00 às 18:00" }, …] */
export function summarizeBusinessHours(hours: BusinessHours) {
  const ordered = weekOrder.map((day) => hours.find((h) => h.day === day)).filter((h): h is DayHours => Boolean(h));
  const groups: { first: DayHours; last: DayHours }[] = [];
  for (const day of ordered) {
    const current = groups[groups.length - 1];
    if (current && sameHours(current.last, day)) current.last = day;
    else groups.push({ first: day, last: day });
  }
  return groups.map(({ first, last }) => ({
    label: first.day === last.day ? dayShort[first.day] : `${dayShort[first.day]}–${dayShort[last.day]}`,
    text: first.open ? `${first.start} às ${first.end}` : "Fechado",
  }));
}

export function defaultBusinessHours(): BusinessHours {
  return weekOrder.map((day) => ({
    day,
    open: day >= 1 && day <= 5,
    start: "08:00",
    end: "18:00",
  }));
}
