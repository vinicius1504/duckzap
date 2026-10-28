"use client";

import type { PlanSlug } from "@duckzap/contracts/session";
import type { Billing, Invoice, Plan } from "@duckzap/contracts/settings";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition } from "react";
import { formatDate, formatMoney } from "@/lib/format";
import { requestPlanChangeAction } from "../actions";

const invoiceStatus: Record<Invoice["status"], { label: string; tone: ChipTone }> = {
  paid: { label: "Paga", tone: "ok" },
  open: { label: "Em aberto", tone: "info" },
  overdue: { label: "Atrasada", tone: "err" },
};

const order: PlanSlug[] = ["basico", "pro", "empresarial"];

function limitsText(plan: Plan) {
  const n = (value: number | null, one: string, many: string) =>
    value === null ? `${many} ilimitados` : `${value} ${value === 1 ? one : many}`;
  const parts = [n(plan.limits.channels, "canal", "canais"), n(plan.limits.users, "usuário", "usuários"), n(plan.limits.agents, "agente", "agentes")];
  const extras = [
    plan.features.includes("campaigns") && "Campanhas",
    plan.features.includes("instagram") && "Instagram",
    plan.features.includes("copilot") && "Copiloto",
  ].filter(Boolean);
  return [...parts, ...extras].join(" · ");
}

function periodLabel(period: string) {
  const text = formatDate(`${period}-15`, { month: "short", year: "numeric" }).replace(".", "").replace(" de ", "/");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function BillingPanel({ billing, timeZone }: { billing: Billing; timeZone: string }) {
  const [notice, setNotice] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [pendingSlug, setPendingSlug] = useState<PlanSlug | null>(null);
  const [, startTransition] = useTransition();
  const currentIndex = order.indexOf(billing.currentPlan);
  const current = billing.plans.find((p) => p.slug === billing.currentPlan);

  function change(plan: Plan) {
    setPendingSlug(plan.slug);
    startTransition(async () => {
      const result = await requestPlanChangeAction(plan.slug);
      setPendingSlug(null);
      if (!result.ok) setNotice({ tone: "err", text: result.error });
      else
        setNotice({
          tone: "info",
          text: result.data.checkoutUrl.startsWith("https://")
            ? `Abrimos o pagamento do plano ${plan.name} em outra aba.`
            : `Pedido de mudança para o ${plan.name} registrado. O link de pagamento ainda não está definido ([LINK]).`,
        });
      if (result.ok && result.data.checkoutUrl.startsWith("https://")) window.open(result.data.checkoutUrl, "_blank", "noopener");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert tone={billing.paymentOk ? "info" : "err"}>
        Seu plano <strong>{current?.name}</strong> renova em {formatDate(billing.renewsAt, { day: "2-digit", month: "2-digit", year: "numeric" }, timeZone)} ·{" "}
        {billing.paymentOk ? "pagamento em dia." : "pagamento pendente: o envio de mensagens pode ser pausado."}
      </Alert>
      {notice ? (
        <Alert tone={notice.tone} live action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Fechar</Button>}>
          {notice.text}
        </Alert>
      ) : null}

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
        {billing.plans.map((plan) => {
          const isCurrent = plan.slug === billing.currentPlan;
          const upgrade = order.indexOf(plan.slug) > currentIndex;
          return (
            <Card
              key={plan.slug}
              className={cn("flex flex-col gap-2 p-[22px]", isCurrent && "border-duck ring-2 ring-duck/50")}
              aria-label={`Plano ${plan.name}${isCurrent ? " (seu plano)" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-bold">{plan.name}</h3>
                {isCurrent ? <Chip className="bg-duck text-on-duck">Seu plano</Chip> : null}
              </div>
              <p>
                <span className="text-[28px] font-extrabold">{plan.priceCents === null ? "R$ [A DEFINIR]" : formatMoney(plan.priceCents)}</span>
                <span className="text-ink-2">/mês</span>
              </p>
              <p className="text-[13px] text-ink-2">{limitsText(plan)}</p>
              <div className="mt-auto pt-2">
                {isCurrent ? (
                  <Button disabled className="w-full">
                    Plano atual
                  </Button>
                ) : (
                  <Button
                    variant={upgrade ? "primary" : "secondary"}
                    className="w-full"
                    disabled={pendingSlug !== null}
                    onClick={() => change(plan)}
                  >
                    {pendingSlug === plan.slug ? "Aguarde…" : upgrade ? "Fazer upgrade" : "Mudar para este"}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <p className="text-[13px] text-ink-2">
        Em uso: {billing.usage.channels} canais · {billing.usage.users} usuários · {billing.usage.agents} agentes.
      </p>

      {billing.invoices.length ? (
        <Table minWidth={560}>
          <thead>
            <tr>
              <Th>Fatura</Th>
              <Th>Vencimento</Th>
              <Th>Valor</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Ações</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {billing.invoices.map((invoice) => {
              const status = invoiceStatus[invoice.status];
              return (
                <tr key={invoice.id}>
                  <Td>{periodLabel(invoice.period)}</Td>
                  <Td>{formatDate(invoice.dueDate, { day: "2-digit", month: "2-digit", year: "numeric" }, timeZone)}</Td>
                  <Td>{invoice.amountCents === null ? "R$ [VALOR]" : formatMoney(invoice.amountCents)}</Td>
                  <Td>
                    <Chip tone={status.tone}>{status.label}</Chip>
                  </Td>
                  <Td className="text-right">
                    {invoice.pdfUrl ? (
                      <a href={invoice.pdfUrl} className="text-[13px] font-semibold underline" download>
                        Baixar
                      </a>
                    ) : (
                      <Button size="sm" disabled title="O PDF fica disponível quando a cobrança for ligada">
                        Baixar
                      </Button>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <Card>
          <EmptyState icon="card" title="Nenhuma fatura ainda" description="As faturas aparecem aqui depois do primeiro pagamento." />
        </Card>
      )}
    </div>
  );
}
