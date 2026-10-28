// Regras puras do Painel Admin (sem banco): status calculado, datas no fuso da plataforma, motivo, diffs.

export const PLATFORM_TIME_ZONE = "America/Sao_Paulo";
/** Tolerância: 1 dia depois do vencimento = vencida ("pague até amanhã"), a conta ainda usa tudo. */
export const OVERDUE_MAX_DAYS = 1;
/** Sem faixa "atrasada": passada a tolerância a conta é expirada (suspensa, bloqueio total). */
export const PAST_DUE_MAX_DAYS = OVERDUE_MAX_DAYS;

export type CompanyStatus = "active" | "trial" | "overdue" | "past_due" | "expired" | "disabled";
export type StoredSubscriptionStatus = "trial" | "active" | "past_due" | "expired" | "canceled";

/** AAAA-MM-DD de um instante, no fuso da plataforma. */
export function dateInPlatformTz(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLATFORM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Diferença em dias inteiros entre duas datas AAAA-MM-DD (a - b). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
}

export function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Dias desde o vencimento; null se ainda não venceu (o próprio dia do vencimento não é atraso). */
export function daysPastDue(dueDate: string, today: string): number | null {
  const late = diffDays(today, dueDate);
  return late > 0 ? late : null;
}

/**
 * Situação da empresa: desativada > em teste/em dia > vencida (1 dia de tolerância) > expirada (suspensa). Mesma regra de `effectiveSubscriptionStatus`.
 * A mesma regra existe em SQL em `queries.ts` (STATUS_CASE); o teste de integração compara as duas.
 */
export function companyStatusOf(input: {
  enabled: boolean;
  onTrial: boolean;
  dueDate: string;
  today: string;
}): CompanyStatus {
  if (!input.enabled) return "disabled";
  const late = daysPastDue(input.dueDate, input.today);
  if (late === null) return input.onTrial ? "trial" : "active";
  if (late <= OVERDUE_MAX_DAYS) return "overdue";
  return "expired";
}

/** Valor para `subscriptions.status` (conjunto restrito pelo check do banco), mantido em sincronia nas mutações. */
export function storedStatusFor(status: CompanyStatus): StoredSubscriptionStatus {
  switch (status) {
    case "disabled":
      return "canceled";
    case "trial":
      return "trial";
    case "active":
      return "active";
    case "overdue":
    case "past_due":
      return "past_due";
    case "expired":
      return "expired";
  }
}

/** Fim do dia do vencimento no fuso da plataforma (Brasil sem horário de verão desde 2019: UTC-3). */
export function endOfDueDate(dueDate: string): Date {
  return new Date(`${dueDate}T23:59:59-03:00`);
}

/** "2026-11-12" → "12/11/2026" */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function formatPrice(cents: number | null): string {
  if (cents === null) return "R$ [VALOR]";
  const reais = (cents / 100).toFixed(2).replace(".", ",");
  return `R$ ${reais.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

/** Motivo obrigatório (≥ 10 caracteres úteis) em toda ação que altera dados. */
export function validateReason(reason: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH) {
    return { ok: false, message: "Explique o motivo (pelo menos 10 caracteres)." };
  }
  if (reason.trim().length > MAX_REASON_LENGTH) return { ok: false, message: "Use no máximo 500 caracteres." };
  return { ok: true, reason: reason.trim() };
}

export type Change = { field: string; from: string | null; to: string | null };

/** Diferenças campo a campo entre dois "retratos" já em texto de exibição. */
export function diffRecords(before: Record<string, string>, after: Record<string, string>): Change[] {
  return Object.keys(after)
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, from: before[field] ?? null, to: after[field] ?? null }));
}

/** Busca sem acento e sem caixa. */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function slugify(name: string): string {
  return foldText(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
