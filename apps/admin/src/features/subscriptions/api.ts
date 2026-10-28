import "server-only";
import {
  invoiceSchema,
  subscriptionSchema,
  type Invoice,
  type Paginated,
  type Subscription,
  type SubscriptionCounts,
  type SubscriptionListQuery,
} from "@duckzap/contracts/admin";
import { z } from "zod";
import { apiRead, apiReadOrNull, paginatedOf } from "@/lib/api-server";

// Ligado ao back (somente leitura no painel; mudanças de plano/vencimento passam por Empresas e são auditadas lá):
//   GET /v1/admin/subscriptions?filter&search&page   → listSubscriptions
//   GET /v1/admin/subscriptions/counts                → getSubscriptionCounts
//   GET /v1/admin/subscriptions/:id                   → getSubscription
//   GET /v1/admin/subscriptions/:id/invoices          → listInvoices
// O gateway (Asaas ou Stripe) ainda está [A DEFINIR] em ADR (§2).

export const SUBSCRIPTIONS_PAGE_SIZE = 10;

const countsSchema = z.object({
  all: z.number().int(),
  active: z.number().int(),
  trial: z.number().int(),
  late: z.number().int(),
  expired: z.number().int(),
  canceled: z.number().int(),
});

export async function listSubscriptions(query: SubscriptionListQuery): Promise<Paginated<Subscription>> {
  const params = new URLSearchParams({ filter: query.filter, search: query.search, page: String(query.page) });
  return apiRead(`/v1/admin/subscriptions?${params}`, paginatedOf(subscriptionSchema));
}

export async function getSubscriptionCounts(): Promise<SubscriptionCounts> {
  return apiRead("/v1/admin/subscriptions/counts", countsSchema);
}

export async function getSubscription(id: string): Promise<Subscription | null> {
  return apiReadOrNull(`/v1/admin/subscriptions/${encodeURIComponent(id)}`, subscriptionSchema);
}

export async function listInvoices(subscriptionId: string): Promise<Invoice[]> {
  return apiRead(`/v1/admin/subscriptions/${encodeURIComponent(subscriptionId)}/invoices`, z.array(invoiceSchema));
}
