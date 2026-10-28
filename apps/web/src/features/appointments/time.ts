import { addDays, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from "date-fns";

// Calendário no fuso da organização. Instantes vêm em UTC (ISO); dias do calendário são strings
// "yyyy-MM-dd" e a aritmética de dias usa date-fns sobre datas locais à meia-noite (independe do fuso do processo).

export const WEEK_STARTS_ON = 1; // segunda

function parts(ms: number, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const get = (type: string) => Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Dia (yyyy-MM-dd) de um instante no fuso. */
export function zonedDay(iso: string, timeZone: string) {
  const p = parts(Date.parse(iso), timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Minutos desde a meia-noite no fuso. */
export function zonedMinutes(iso: string, timeZone: string) {
  const p = parts(Date.parse(iso), timeZone);
  return p.h * 60 + p.min;
}

/** "HH:mm" no fuso. */
export function zonedTime(iso: string, timeZone: string) {
  const p = parts(Date.parse(iso), timeZone);
  return `${pad(p.h)}:${pad(p.min)}`;
}

/** Hora curta à brasileira: 09:00 → "09h", 15:30 → "15h30". */
export function shortTime(iso: string, timeZone: string) {
  const p = parts(Date.parse(iso), timeZone);
  return `${pad(p.h)}h${p.min ? pad(p.min) : ""}`;
}

function offsetMinutes(utcMs: number, timeZone: string) {
  const p = parts(utcMs, timeZone);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(utcMs / 1000) * 1000) / 60000;
}

/** Dia + hora no fuso → ISO em UTC. */
export function zonedToUtc(day: string, time: string, timeZone: string) {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  const [h = 0, min = 0] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ms = guess - offsetMinutes(guess, timeZone) * 60000;
  ms = guess - offsetMinutes(ms, timeZone) * 60000; // segunda passada acerta mudanças de horário
  return new Date(ms).toISOString();
}

export function todayIn(timeZone: string) {
  return zonedDay(new Date().toISOString(), timeZone);
}

/** "yyyy-MM-dd" → Date local à meia-noite (só para aritmética de dias). */
export function dayToDate(day: string) {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function dateToDay(date: Date) {
  return format(date, "yyyy-MM-dd");
}

export function shiftDay(day: string, days: number) {
  return dateToDay(addDays(dayToDate(day), days));
}

export type AgendaView = "mes" | "semana" | "lista";

export const LIST_DAYS = 14;

/** Intervalo de dias (inclusive) que cada visão mostra a partir do dia de referência. */
export function rangeFor(view: AgendaView, anchor: string) {
  const date = dayToDate(anchor);
  if (view === "mes") {
    return {
      from: dateToDay(startOfWeek(startOfMonth(date), { weekStartsOn: WEEK_STARTS_ON })),
      to: dateToDay(endOfWeek(endOfMonth(date), { weekStartsOn: WEEK_STARTS_ON })),
    };
  }
  if (view === "semana") {
    const start = startOfWeek(date, { weekStartsOn: WEEK_STARTS_ON });
    return { from: dateToDay(start), to: dateToDay(addDays(start, 6)) };
  }
  return { from: anchor, to: shiftDay(anchor, LIST_DAYS - 1) };
}

export function daysBetween(from: string, to: string) {
  const days: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) days.push(d);
  return days;
}

/** Dia exibido (yyyy-MM-dd) com Intl, sem depender do fuso do processo. */
export function formatDay(day: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...options }).format(new Date(`${day}T12:00:00Z`));
}
