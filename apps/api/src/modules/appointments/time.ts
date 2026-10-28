// Dia + hora no fuso da empresa ⇄ instante UTC. Espelha apps/web/src/features/appointments/time.ts
// (mesmo algoritmo de duas passadas, que acerta mudanças de horário de verão). O servidor é quem converte.

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
  const found = new Map<string, number>(fmt.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  const get = (type: string) => found.get(type) ?? 0;
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Dia (AAAA-MM-DD) de um instante no fuso. */
export function zonedDay(iso: string, timeZone: string) {
  const p = parts(Date.parse(iso), timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** "HH:mm" de um instante no fuso. */
export function zonedTime(iso: string, timeZone: string) {
  const p = parts(Date.parse(iso), timeZone);
  return `${pad(p.h)}:${pad(p.min)}`;
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
  ms = guess - offsetMinutes(ms, timeZone) * 60000;
  return new Date(ms).toISOString();
}

export function todayIn(timeZone: string, now = new Date()) {
  return zonedDay(now.toISOString(), timeZone);
}

/** Soma dias a um AAAA-MM-DD (aritmética de calendário, sem fuso). */
export function shiftDay(day: string, days: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Início do dia (00:00 no fuso) em UTC. */
export function dayStartUtc(day: string, timeZone: string) {
  return new Date(zonedToUtc(day, "00:00", timeZone));
}

/** [início, fim) em UTC dos dias `from`..`to` (inclusive) no fuso. */
export function dayRangeUtc(from: string, to: string, timeZone: string) {
  return { start: dayStartUtc(from, timeZone), end: dayStartUtc(shiftDay(to, 1), timeZone) };
}
