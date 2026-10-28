/**
 * Horário como o CLIENTE entende: dia da semana, data e hora no fuso da empresa. O banco e as ferramentas falam em UTC
 * ("2026-10-30T17:00:00Z"); se isso chega cru ao modelo, ele repete "17h (horário UTC)" para quem tem a reunião às 14h.
 */

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

function partsOf(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function safeZone(timeZone: string | undefined): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** "quarta-feira, 28/10 às 08:30". Instante inválido devolve o texto original. */
export function formatLocal(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = partsOf(date, safeZone(timeZone));
  return `${p.weekday}, ${p.day}/${p.month} às ${p.hour}:${p.minute}`;
}

/** Data local AAAA-MM-DD (é o formato que as ferramentas de agenda pedem). */
export function localDate(date: Date, timeZone?: string): string {
  const p = partsOf(date, safeZone(timeZone));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "quarta-feira, 28/10/2026, 10:00 (fuso America/Sao_Paulo; hoje é 2026-10-28)". */
export function formatNow(now: Date, timeZone?: string): string {
  const zone = safeZone(timeZone);
  const p = partsOf(now, zone);
  return `${p.weekday}, ${p.day}/${p.month}/${p.year}, ${p.hour}:${p.minute} (fuso ${zone}; hoje é ${p.year}-${p.month}-${p.day})`;
}

/** Hora local (0–23) de um instante. */
export function localHour(iso: string, timeZone?: string): number {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 0 : Number(partsOf(date, safeZone(timeZone)).hour);
}

/** Minutos desde 00:00 no fuso local (para filtrar por faixa de hora). */
export function localMinutes(iso: string, timeZone?: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 0;
  const p = partsOf(date, safeZone(timeZone));
  return Number(p.hour) * 60 + Number(p.minute);
}

/** "HH:MM" → minutos; inválido → null. */
export function parseClock(value: string | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Poucos horários, espalhados, para a IA não ler uma fila de 30. O limite `max` (8) se divide entre os dias consultados:
 * 1 dia mostra até 8 horários espaçados ao longo do dia; uma semana mostra o primeiro horário de cada dia. Quem precisa de
 * outro horário consulta de novo com um dia só ou com a faixa de hora (`from_time`/`to_time`), que é o caminho certo.
 */
export function spreadSlots<T extends { startsAt: string }>(slots: readonly T[], timeZone: string | undefined, max = 8): T[] {
  const days = new Map<string, T[]>();
  for (const slot of [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const key = localDate(new Date(slot.startsAt), timeZone);
    days.set(key, [...(days.get(key) ?? []), slot]);
  }
  if (days.size === 0) return [];
  const perDay = Math.max(1, Math.min(4, Math.floor(max / days.size)));
  const picked: T[] = [];
  for (const daySlots of days.values()) {
    const n = daySlots.length;
    const take = Math.min(perDay, n);
    // índices igualmente espaçados: o primeiro e o último do dia entram quando há mais de um
    const idx = take === 1 ? [0] : Array.from({ length: take }, (_, i) => Math.round((i * (n - 1)) / (take - 1)));
    for (const i of new Set(idx)) {
      const slot = daySlots[i];
      if (slot) picked.push(slot);
    }
    if (picked.length >= max) break;
  }
  return picked.slice(0, max);
}

/** O nome do cadastro serve para chamar o cliente? Telefone, vazio ou "sem nome" não servem (o cadastro nasce com o número). */
export function hasRealName(name: string | null | undefined): boolean {
  const text = (name ?? "").trim();
  if (text.length < 2) return false;
  if (/^\(?(sem nome|cliente|contato|desconhecido)\)?$/i.test(text)) return false;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const digits = (text.match(/\d/g) ?? []).length;
  return letters >= 2 && letters > digits;
}
