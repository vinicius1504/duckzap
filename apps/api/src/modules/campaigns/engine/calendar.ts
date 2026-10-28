// Calendário no fuso da empresa: janela de envio, domingos e feriados (§5.7 item 2). Funções puras, sem dependência de relógio.

export type LocalParts = { date: string; hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Data/hora de um instante no fuso. `weekday`: 0 = domingo. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
  };
}

export function localDate(instant: Date, timeZone: string) {
  return localParts(instant, timeZone).date;
}

/** Deslocamento (ms) do fuso em relação ao UTC naquele instante. */
function offsetMs(instant: Date, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** "AAAA-MM-DD" + "HH:MM" no fuso → instante UTC. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - offsetMs(new Date(guess), timeZone);
  result = guess - offsetMs(new Date(result), timeZone); // segunda passada cobre a virada do horário de verão
  return new Date(result);
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Páscoa (algoritmo de Meeus/Jones/Butcher), como "AAAA-MM-DD". */
export function easter(year: number) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Feriados nacionais do Brasil + Carnaval (segunda e terça), Sexta-feira Santa e Corpus Christi (pontos facultativos
 * que fecham o comércio). Feriados estaduais/municipais não entram: não há cadastro por empresa ainda.
 */
export function nationalHolidays(year: number): Set<string> {
  const fixed = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"].map((md) => `${year}-${md}`);
  const easterDate = easter(year);
  const moving = [-48, -47, -2, 60].map((offset) => addDays(easterDate, offset));
  return new Set([...fixed, ...moving]);
}

export function isHoliday(date: string) {
  return nationalHolidays(Number(date.slice(0, 4))).has(date);
}

/** Dia permitido para envio: sem domingo/feriado quando `skipSundaysAndHolidays`. */
export function isSendDay(date: string, skipSundaysAndHolidays: boolean) {
  if (!skipSundaysAndHolidays) return true;
  return weekdayOf(date) !== 0 && !isHoliday(date);
}

export function nextSendDay(date: string, skipSundaysAndHolidays: boolean) {
  let current = date;
  for (let i = 0; i < 14 && !isSendDay(current, skipSundaysAndHolidays); i++) current = addDays(current, 1);
  return current;
}

export type SendWindow = { start: string; end: string; skipSundaysAndHolidays: boolean; timeZone: string };

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/** A janela precisa abrir e fechar no mesmo dia (início < fim). */
export function isValidWindow(start: string, end: string) {
  return /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && toMinutes(end) > toMinutes(start) && toMinutes(end) <= 24 * 60;
}

export function isWithinWindow(now: Date, window: SendWindow) {
  const p = localParts(now, window.timeZone);
  if (!isSendDay(p.date, window.skipSundaysAndHolidays)) return false;
  const minutes = p.hour * 60 + p.minute;
  return minutes >= toMinutes(window.start) && minutes < toMinutes(window.end);
}

/** Agora, se estiver na janela; senão o próximo início de janela em dia permitido. */
export function nextWindowOpening(now: Date, window: SendWindow): Date {
  if (isWithinWindow(now, window)) return now;
  const p = localParts(now, window.timeZone);
  const minutes = p.hour * 60 + p.minute;
  let date = p.date;
  // hoje ainda vai abrir (antes do início) e é dia permitido
  if (!(minutes < toMinutes(window.start) && isSendDay(date, window.skipSundaysAndHolidays))) date = addDays(date, 1);
  date = nextSendDay(date, window.skipSundaysAndHolidays);
  return zonedToUtc(date, window.start, window.timeZone);
}
