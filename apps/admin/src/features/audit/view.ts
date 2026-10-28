import type { AuditAction, AuditEntry, AuditFilter } from "@duckzap/contracts/admin";
import type { ChipTone } from "@duckzap/ui/components/chip";

export const auditActionView: Record<AuditAction, { label: string; tone: ChipTone }> = {
  "company.plan_changed": { label: "Alterou o plano", tone: "info" },
  "company.due_date_extended": { label: "Prorrogou", tone: "warn" },
  "company.disabled": { label: "Desativou", tone: "err" },
  "company.enabled": { label: "Ativou", tone: "ok" },
  "plan.created": { label: "Criou plano", tone: "ok" },
  "plan.updated": { label: "Editou plano", tone: "info" },
  "plan.deleted": { label: "Excluiu plano", tone: "err" },
};

/** "Plano: Pro → Escala · Vencimento: 05/11 → 12/11" (até 3 mudanças). */
export function describeChanges(entry: AuditEntry, max = 3) {
  const parts = entry.changes.slice(0, max).map((c) => {
    if (c.from === null) return `${c.field}: ${c.to ?? "—"}`;
    if (c.to === null) return `${c.field}: ${c.from} (removido)`;
    return `${c.field}: ${c.from} → ${c.to}`;
  });
  const rest = entry.changes.length - max;
  return rest > 0 ? `${parts.join(" · ")} · +${rest}` : parts.join(" · ");
}

export const auditFilterSlugs = {
  todas: "all",
  empresas: "companies",
  planos: "plans",
} as const satisfies Record<string, AuditFilter>;
export type AuditFilterSlug = keyof typeof auditFilterSlugs;

export function isAuditFilterSlug(value: string | undefined): value is AuditFilterSlug {
  return value !== undefined && Object.hasOwn(auditFilterSlugs, value);
}
