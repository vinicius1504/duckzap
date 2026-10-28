import "server-only";
import {
  auditEntrySchema,
  companySchema,
  invoiceSchema,
  type AuditEntry,
  type ChangeCompanyPlanInput,
  type Company,
  type CompanyCounts,
  type CompanyListQuery,
  type ExtendCompanyInput,
  type Invoice,
  type Paginated,
  type SetCompanyEnabledInput,
} from "@duckzap/contracts/admin";
import { z } from "zod";
import { apiCommand, apiRead, apiReadOrNull, paginatedOf } from "@/lib/api-server";
import type { Result } from "@/lib/result";

// Ligado ao back. Toda escrita grava a linha de audit_logs na MESMA transação, com o super admin da sessão e o IP:
//   GET   /v1/admin/companies?filter&search&page        → listCompanies
//   GET   /v1/admin/companies/counts                     → getCompanyCounts
//   GET   /v1/admin/companies/:id                        → getCompanyDetail
//   POST  /v1/admin/companies/:id/plan      {planId, reason}   → changeCompanyPlan
//   POST  /v1/admin/companies/:id/extend    {dueDate, reason}  → extendCompany
//   POST  /v1/admin/companies/:id/enabled   {enabled, reason}  → setCompanyEnabled

export const COMPANIES_PAGE_SIZE = 10;

const countsSchema = z.object({
  all: z.number().int(),
  active: z.number().int(),
  trial: z.number().int(),
  overdue: z.number().int(),
  past_due: z.number().int(),
  expired: z.number().int(),
});

const detailSchema = z.object({
  company: companySchema,
  subscriptionId: z.string(),
  invoices: z.array(invoiceSchema),
  history: z.array(auditEntrySchema),
});

export async function listCompanies(query: CompanyListQuery): Promise<Paginated<Company>> {
  const params = new URLSearchParams({ filter: query.filter, search: query.search, page: String(query.page) });
  return apiRead(`/v1/admin/companies?${params}`, paginatedOf(companySchema));
}

export async function getCompanyCounts(): Promise<CompanyCounts> {
  return apiRead("/v1/admin/companies/counts", countsSchema);
}

export type CompanyDetail = {
  company: Company;
  subscriptionId: string;
  invoices: Invoice[];
  history: AuditEntry[];
};

export async function getCompanyDetail(id: string): Promise<CompanyDetail | null> {
  return apiReadOrNull(`/v1/admin/companies/${encodeURIComponent(id)}`, detailSchema);
}

type MutationError = "not_found" | "invalid" | "unavailable";

export async function changeCompanyPlan(input: ChangeCompanyPlanInput): Promise<Result<Company, MutationError>> {
  return apiCommand(
    `/v1/admin/companies/${encodeURIComponent(input.companyId)}/plan`,
    { method: "POST", body: { planId: input.planId, reason: input.reason } },
    companySchema,
    ["not_found", "invalid"],
    "invalid",
  );
}

export async function extendCompany(input: ExtendCompanyInput): Promise<Result<Company, MutationError>> {
  return apiCommand(
    `/v1/admin/companies/${encodeURIComponent(input.companyId)}/extend`,
    { method: "POST", body: { dueDate: input.dueDate, reason: input.reason } },
    companySchema,
    ["not_found", "invalid"],
    "invalid",
  );
}

export async function setCompanyEnabled(input: SetCompanyEnabledInput): Promise<Result<Company, MutationError>> {
  return apiCommand(
    `/v1/admin/companies/${encodeURIComponent(input.companyId)}/enabled`,
    { method: "POST", body: { enabled: input.enabled, reason: input.reason } },
    companySchema,
    ["not_found", "invalid"],
    "invalid",
  );
}
