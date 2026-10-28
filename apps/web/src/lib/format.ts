// Formatação para exibição em pt-BR. Datas chegam em UTC (ISO) e são mostradas no fuso da organização.

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/** 72 → "1 min 12 s"; 840 → "14 min"; 4000 → "1 h 6 min". */
export function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return sec > 0 && m < 10 ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

export function formatDate(iso: string, options: Intl.DateTimeFormatOptions, timeZone = DEFAULT_TIME_ZONE) {
  const date = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat("pt-BR", { timeZone, ...options }).format(date);
}

/** "2026-10-20" → "Ter" */
export function formatShortWeekday(isoDate: string, timeZone = DEFAULT_TIME_ZONE) {
  const text = formatDate(isoDate, { weekday: "short" }, timeZone).replace(".", "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Centavos → "R$ 1.234,56" */
export function formatMoney(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

export function formatPhone(e164: string) {
  const digits = e164.replace(/\D/g, "");
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : e164;
}

/** Hora da organização → "Bom dia" | "Boa tarde" | "Boa noite" */
export function greeting(now: Date, timeZone = DEFAULT_TIME_ZONE) {
  const hour = Number(new Intl.DateTimeFormat("pt-BR", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}
