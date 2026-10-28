// Formatação para exibição em pt-BR. Datas chegam em UTC (ISO) e são mostradas no fuso da plataforma.

export const PLATFORM_TIME_ZONE = "America/Sao_Paulo";

export function formatDate(
  iso: string,
  options: Intl.DateTimeFormatOptions,
  timeZone = PLATFORM_TIME_ZONE,
) {
  // data pura (AAAA-MM-DD) é tratada como meio-dia UTC para não "voltar um dia" no fuso
  const date = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat("pt-BR", { timeZone, ...options }).format(date);
}

/** "2026-11-12" → "12/11/2026" */
export function formatDay(iso: string, timeZone = PLATFORM_TIME_ZONE) {
  return formatDate(iso, { day: "2-digit", month: "2-digit", year: "numeric" }, timeZone);
}

/** ISO → "26/10/2026 14:32" */
export function formatDateTime(iso: string, timeZone = PLATFORM_TIME_ZONE) {
  return formatDate(
    iso,
    { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" },
    timeZone,
  );
}

/** "2026-05" → "mai" */
export function formatMonthShort(yearMonth: string) {
  const text = formatDate(`${yearMonth}-15`, { month: "short" }).replace(".", "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Centavos → "R$ 1.234,56" */
export function formatMoney(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

/** Preço que ainda pode estar a definir: null → "R$ [VALOR]" (placeholder do design). */
export function formatPrice(cents: number | null) {
  return cents === null ? "R$ [VALOR]" : formatMoney(cents);
}

/** Centavos → "1234,56" (valor de campo de formulário). */
export function centsToInput(cents: number | null) {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** "1.234,56" | "1234.5" | "R$ 99" → centavos; "" → null; inválido → NaN. */
export function parseMoneyInput(value: string): number | null {
  const clean = value.replace(/R\$\s?/i, "").replace(/\s/g, "");
  if (clean === "") return null;
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  return Math.round(Number(normalized) * 100);
}

export function formatPhone(e164: string) {
  const digits = e164.replace(/\D/g, "");
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : e164;
}

/** "12345678000190" → "12.345.678/0001-90" */
export function formatCnpj(digits: string) {
  const m = /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/.exec(digits);
  return m ? `${m[1]}.${m[2]}.${m[3]}/${m[4]}-${m[5]}` : digits;
}

/** Data de hoje (AAAA-MM-DD) no fuso da plataforma. */
export function todayIso(now = new Date(), timeZone = PLATFORM_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Soma dias a uma data AAAA-MM-DD. */
export function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Dias de `from` até `to` (datas AAAA-MM-DD). */
export function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}
