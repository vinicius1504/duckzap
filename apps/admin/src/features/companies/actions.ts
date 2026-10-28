"use server";

import {
  changeCompanyPlanSchema,
  extendCompanySchema,
  setCompanyEnabledSchema,
  type AdminActionResult,
  type ChangeCompanyPlanInput,
  type ExtendCompanyInput,
  type SetCompanyEnabledInput,
} from "@duckzap/contracts/admin";
import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/features/auth/session";
import { formatDay } from "@/lib/format";
import { changeCompanyPlan, extendCompany, setCompanyEnabled } from "./api";

// Server Actions finas: sessão → validação → api.ts → revalidar. A auditoria é feita pelo back.

function revalidate() {
  revalidatePath("/empresas");
  revalidatePath("/assinaturas");
  revalidatePath("/auditoria");
  revalidatePath("/visao-geral");
}

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Confira os dados e tente de novo.";
}

export async function changeCompanyPlanAction(
  input: ChangeCompanyPlanInput,
): Promise<AdminActionResult> {
  await requireAdminSession();
  const parsed = changeCompanyPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const result = await changeCompanyPlan(parsed.data);
  if (!result.ok) return { ok: false, error: result.message };
  revalidate();
  return {
    ok: true,
    message: `${result.data.name} agora está no plano ${result.data.planName}. Registrado na auditoria.`,
  };
}

export async function extendCompanyAction(input: ExtendCompanyInput): Promise<AdminActionResult> {
  await requireAdminSession();
  const parsed = extendCompanySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const result = await extendCompany(parsed.data);
  if (!result.ok) return { ok: false, error: result.message };
  revalidate();
  return {
    ok: true,
    message: `${result.data.name} prorrogada até ${formatDay(result.data.dueDate)}. Registrado na auditoria.`,
  };
}

export async function setCompanyEnabledAction(
  input: SetCompanyEnabledInput,
): Promise<AdminActionResult> {
  await requireAdminSession();
  const parsed = setCompanyEnabledSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const result = await setCompanyEnabled(parsed.data);
  if (!result.ok) return { ok: false, error: result.message };
  revalidate();
  return {
    ok: true,
    message: `${result.data.name} foi ${result.data.enabled ? "ativada" : "desativada"}. Registrado na auditoria.`,
  };
}
