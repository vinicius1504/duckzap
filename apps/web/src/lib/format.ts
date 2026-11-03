import { formatPriceBRL } from "@duckzap/contracts/catalog";

// Formatação para exibição em pt-BR. Datas chegam em UTC (ISO) e são mostradas no fuso da organização.
// É o ÚNICO lugar de formatação: não repita `toLocaleString`, `Intl.*` nem `n === 1 ? ... : ...` nas telas.

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

/** Centavos → "R$ 1.234,56". Mesmo formato que a IA fala (ela e o guardrail de preço usam `formatPriceBRL`). */
export function formatMoney(cents: number) {
  return formatPriceBRL(cents);
}

/** 12345 → "12.345" */
export function formatNumber(value: number) {
  return value.toLocaleString("pt-BR");
}

/** Plural simples: `formatPlural(1, "item", "itens")` → "1 item"; `(0|2, ...)` → "0 itens" / "2 itens". */
export function formatPlural(count: number, one: string, many: string) {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** "Marina Souza" → "Marina". */
export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** Opções de `formatDate` com nome. Use estas em vez de repetir o objeto na tela. */
export const DATE_FORMATS = {
  /** 20/10/2026 */
  day: { day: "2-digit", month: "2-digit", year: "numeric" },
  /** 20/10 */
  dayMonth: { day: "2-digit", month: "2-digit" },
  /** 20/10, 14:30 */
  dayTime: { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" },
  /** 14:30 */
  time: { hour: "2-digit", minute: "2-digit" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

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
