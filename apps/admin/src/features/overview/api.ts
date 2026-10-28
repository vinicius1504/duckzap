import "server-only";
import { platformOverviewSchema, type PlatformOverview } from "@duckzap/contracts/admin";
import { apiRead } from "@/lib/api-server";

// Ligado ao back: GET /v1/admin/overview (KPIs, MRR das faturas pagas e cadastros por semana, tudo calculado na API).

export async function getPlatformOverview(): Promise<PlatformOverview> {
  return apiRead("/v1/admin/overview", platformOverviewSchema);
}
