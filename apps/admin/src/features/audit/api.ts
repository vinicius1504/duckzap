import "server-only";
import { auditEntrySchema, type AuditEntry, type AuditListQuery, type Paginated } from "@duckzap/contracts/admin";
import { apiRead, paginatedOf } from "@/lib/api-server";

// Ligado ao back: GET /v1/admin/audit?filter&search&companyId&page (tabela audit_logs, só inserção).
// As linhas são gravadas pela API, na mesma transação de cada mutação do painel.

export const AUDIT_PAGE_SIZE = 15;

export async function listAuditEntries(query: AuditListQuery): Promise<Paginated<AuditEntry>> {
  const params = new URLSearchParams({ filter: query.filter, search: query.search, page: String(query.page) });
  if (query.companyId) params.set("companyId", query.companyId);
  return apiRead(`/v1/admin/audit?${params}`, paginatedOf(auditEntrySchema));
}
