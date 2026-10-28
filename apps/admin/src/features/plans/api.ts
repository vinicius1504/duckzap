import "server-only";
import { planSchema, type Plan, type PlanInput } from "@duckzap/contracts/admin";
import { z } from "zod";
import { apiCommand, apiRead } from "@/lib/api-server";
import type { Result } from "@/lib/result";

// Ligado ao back (tabela plans, §1.2). Toda escrita exige motivo e grava em audit_logs na mesma transação:
//   GET    /v1/admin/plans                       → listPlans
//   POST   /v1/admin/plans          {…, reason}  → createPlan
//   PATCH  /v1/admin/plans/:id      {…, reason}  → updatePlan
//   DELETE /v1/admin/plans/:id      {reason}     → deletePlan   (só sem empresas no plano)

export async function listPlans(): Promise<Plan[]> {
  return apiRead("/v1/admin/plans", z.array(planSchema));
}

export async function createPlan(input: PlanInput): Promise<Result<Plan, "duplicate" | "unavailable">> {
  return apiCommand("/v1/admin/plans", { method: "POST", body: input }, planSchema, ["duplicate"], "duplicate");
}

export async function updatePlan(
  id: string,
  input: PlanInput,
): Promise<Result<Plan, "not_found" | "duplicate" | "unchanged" | "unavailable">> {
  return apiCommand(
    `/v1/admin/plans/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input },
    planSchema,
    ["not_found", "duplicate", "unchanged"],
    "unchanged",
  );
}

export async function deletePlan(
  id: string,
  reason: string,
): Promise<Result<null, "not_found" | "in_use" | "unavailable">> {
  const result = await apiCommand(
    `/v1/admin/plans/${encodeURIComponent(id)}`,
    { method: "DELETE", body: { reason } },
    z.object({ ok: z.literal(true) }),
    ["not_found", "in_use"],
    "in_use",
  );
  return result.ok ? { ok: true, data: null } : result;
}
