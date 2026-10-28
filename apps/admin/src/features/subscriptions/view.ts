import type {
  BillingCycle,
  InvoiceStatus,
  PaymentMethod,
  SubscriptionAdminStatus,
  SubscriptionFilter,
} from "@duckzap/contracts/admin";
import type { ChipTone } from "@duckzap/ui/components/chip";

export function subscriptionStatusView(
  status: SubscriptionAdminStatus,
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
      return { label: "Expirada", tone: "err" };
    case "canceled":
      return { label: "Cancelada", tone: "neutral" };
  }
}

export const cycleLabels: Record<BillingCycle, string> = { monthly: "Mensal", yearly: "Anual" };

export const invoiceStatusView: Record<InvoiceStatus, { label: string; tone: ChipTone }> = {
  paid: { label: "Paga", tone: "ok" },
  open: { label: "Em aberto", tone: "info" },
  overdue: { label: "Vencida", tone: "err" },
  void: { label: "Cancelada", tone: "neutral" },
};

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  pix: "Pix",
  boleto: "Boleto",
  card: "Cartão",
};

export const subscriptionFilterSlugs = {
  todas: "all",
  "em-dia": "active",
  "em-teste": "trial",
  "em-atraso": "late",
  expiradas: "expired",
  canceladas: "canceled",
} as const satisfies Record<string, SubscriptionFilter>;
export type SubscriptionFilterSlug = keyof typeof subscriptionFilterSlugs;

export const subscriptionFilterOrder: readonly SubscriptionFilterSlug[] = [
  "todas",
  "em-dia",
  "em-teste",
  "em-atraso",
  "expiradas",
  "canceladas",
];

export const subscriptionFilterLabels: Record<SubscriptionFilterSlug, string> = {
  todas: "Todas",
  "em-dia": "Em dia",
  "em-teste": "Em teste",
  "em-atraso": "Em atraso",
  expiradas: "Expiradas",
  canceladas: "Canceladas",
};

export function isSubscriptionFilterSlug(
  value: string | undefined,
): value is SubscriptionFilterSlug {
  return value !== undefined && Object.hasOwn(subscriptionFilterSlugs, value);
}
