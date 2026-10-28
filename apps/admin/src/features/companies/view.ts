import type { CompanyFilter, CompanyStatus } from "@duckzap/contracts/admin";
import type { ChipTone } from "@duckzap/ui/components/chip";

// Mapeia o dado (status) para o que a tela mostra. Usado no server e no client.

export function companyStatusView(
  status: CompanyStatus,
  daysPastDue: number | null,
): { label: string; tone: ChipTone } {
  const days = daysPastDue ?? 0;
  const ago = days === 1 ? "há 1 dia" : `há ${days} dias`;
  switch (status) {
    case "active":
      return { label: "Em dia", tone: "ok" };
    case "trial":
      return { label: "Em teste", tone: "info" };
    case "overdue":
      return { label: `Vencida ${ago}`, tone: "warn" };
    case "past_due":
      return { label: `Atrasada ${ago}`, tone: "err" };
    case "expired":
      return { label: days > 0 ? `Expirada ${ago}` : "Expirada", tone: "err" };
    case "disabled":
      return { label: "Desativada", tone: "neutral" };
  }
}

/** Slugs em pt-BR na URL (?status=vencidas) ↔ filtro do contrato. */
export const companyFilterSlugs = {
  todas: "all",
  "em-dia": "active",
  "em-teste": "trial",
  vencidas: "overdue",
  expiradas: "expired",
} as const satisfies Record<string, CompanyFilter>;

export type CompanyFilterSlug = keyof typeof companyFilterSlugs;

export const companyFilterOrder: readonly CompanyFilterSlug[] = [
  "todas",
  "em-dia",
  "em-teste",
  "vencidas",
  "expiradas",
];

export const companyFilterLabels: Record<CompanyFilterSlug, string> = {
  todas: "Todas",
  "em-dia": "Em dia",
  "em-teste": "Em teste",
  vencidas: "Vencidas (1 dia de tolerância)",
  expiradas: "Expiradas",
};

export function isCompanyFilterSlug(value: string | undefined): value is CompanyFilterSlug {
  return value !== undefined && Object.hasOwn(companyFilterSlugs, value);
}
