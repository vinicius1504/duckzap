import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import type { Metadata } from "next";
import { listPlans } from "@/features/plans/api";
import { PlanFormButton } from "@/features/plans/components/plan-dialogs";
import { planResourcesText } from "@/features/plans/view";
import { formatPrice, plural } from "@/lib/format";

export const metadata: Metadata = { title: "Planos" };

export default async function PlansPage() {
  const plans = await listPlans();
  const sorted = [...plans].sort((a, b) => Number(b.active) - Number(a.active));

  return (
    <Page>
      <PageHeader
        title="Planos"
        description="Preço do 1º mês e recorrente, limites, recursos e link de checkout. Toda mudança fica na auditoria."
        actions={<PlanFormButton plan={null} />}
      />

      {sorted.length === 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <EmptyState
            icon="tag"
            title="Nenhum plano cadastrado"
            description="Crie o primeiro plano para as empresas poderem contratar."
            action={<PlanFormButton plan={null} />}
          />
        </div>
      ) : (
        <Table aria-label="Planos" minWidth={900}>
          <thead>
            <tr>
              <Th>Plano</Th>
              <Th>1º mês</Th>
              <Th>Meses seguintes</Th>
              <Th>Recursos</Th>
              <Th>Checkout</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Ações</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((plan) => (
              <tr key={plan.id} className={plan.active ? undefined : "text-ink-2"}>
                <Td>
                  <strong className="text-ink">{plan.name}</strong>
                  <span className="block text-xs text-ink-2">
                    {plural(plan.companiesCount, "empresa", "empresas")}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">{formatPrice(plan.firstMonthPriceCents)}</Td>
                <Td className="whitespace-nowrap">{formatPrice(plan.recurringPriceCents)}</Td>
                <Td>{plan.active ? planResourcesText(plan) : "Plano descontinuado"}</Td>
                <Td className="max-w-56">
                  {plan.checkoutUrl ? (
                    <a
                      href={plan.checkoutUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate underline"
                    >
                      {plan.checkoutUrl.replace(/^https:\/\//, "")}
                    </a>
                  ) : plan.active ? (
                    "[LINK]"
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  <Chip tone={plan.active ? "ok" : "neutral"}>
                    {plan.active ? "Ativo" : "Inativo"}
                  </Chip>
                </Td>
                <Td>
                  <PlanFormButton plan={plan} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
