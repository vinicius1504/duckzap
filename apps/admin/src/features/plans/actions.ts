"use server";

import { planInputSchema, type AdminActionResult, type PlanInput } from "@duckzap/contracts/admin";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdminSession } from "@/features/auth/session";
import { createPlan, deletePlan, updatePlan } from "./api";

// Server Actions finas: sessão → validação → api.ts → revalidar. A auditoria é feita pelo back.

function revalidate() {
  revalidatePath("/planos");
  revalidatePath("/empresas");
  revalidatePath("/assinaturas");
  revalidatePath("/auditoria");
  revalidatePath("/visao-geral");
}

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Confira os dados e tente de novo.";
}

export async function savePlanAction(
  id: string | null,
  input: PlanInput,
): Promise<AdminActionResult> {
  await requireAdminSession();
  const parsed = planInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const result = id
    ? await updatePlan(z.string().min(1).parse(id), parsed.data)
    : await createPlan(parsed.data);
  if (!result.ok) return { ok: false, error: result.message };
  revalidate();
  return {
    ok: true,
    message: `Plano ${result.data.name} ${id ? "atualizado" : "criado"}. Registrado na auditoria.`,
  };
}

const deleteSchema = z.object({
  id: z.string().min(1),
  reason: planInputSchema.shape.reason,
});

export async function deletePlanAction(id: string, reason: string): Promise<AdminActionResult> {
  await requireAdminSession();
  const parsed = deleteSchema.safeParse({ id, reason });
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const result = await deletePlan(parsed.data.id, parsed.data.reason);
  if (!result.ok) return { ok: false, error: result.message };
  revalidate();
  return { ok: true, message: "Plano excluído. Registrado na auditoria." };
}
