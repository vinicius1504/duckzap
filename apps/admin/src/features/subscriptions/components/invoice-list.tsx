import type { Invoice, Subscription } from "@duckzap/contracts/admin";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { formatDateTime, formatDay, formatPrice } from "@/lib/format";
import { invoiceStatusView, paymentMethodLabels, subscriptionStatusView } from "../view";

/** Corpo da gaveta de faturas de uma assinatura. */
export function InvoiceList({
  subscription,
  invoices,
}: {
  subscription: Subscription;
  invoices: Invoice[];
}) {
  const status = subscriptionStatusView(subscription.status, subscription.daysPastDue);
  const overdue = invoices.filter((i) => i.status === "overdue");

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={status.tone}>{status.label}</Chip>
        <Chip>Próximo vencimento: {formatDay(subscription.nextDueDate)}</Chip>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-ink-2">Assinante desde</dt>
        <dd>{formatDay(subscription.startedAt)}</dd>
        <dt className="text-ink-2">Gateway</dt>
        <dd>{subscription.gateway ?? "[A DEFINIR]"}</dd>
        <dt className="text-ink-2">Referência</dt>
        <dd>{subscription.gatewayReference ?? "—"}</dd>
      </dl>

      {overdue.length ? (
        <Alert tone="err" title="Pagamento atrasado.">
          {overdue.length === 1 ? "1 fatura vencida" : `${overdue.length} faturas vencidas`}. Para
          dar mais prazo, use “Prorrogar” na empresa.
        </Alert>
      ) : null}

      {invoices.length === 0 ? (
        <EmptyState
          icon="file"
          title={subscription.onTrial ? "Sem faturas no teste" : "Nenhuma fatura ainda"}
          description={
            subscription.onTrial
              ? "A primeira fatura sai quando a empresa contratar um plano."
              : "As faturas aparecem aqui quando o gateway gerar a cobrança."
          }
        />
      ) : (
        <ul className="flex flex-col">
          {invoices.map((invoice) => {
            const view = invoiceStatusView[invoice.status];
            return (
              <li
                key={invoice.id}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0",
                  invoice.status === "overdue" &&
                    "-mx-2 rounded-control border-b-0 bg-err-bg/50 px-2",
                )}
              >
                <div className="min-w-0 flex-[1_1_180px]">
                  <p className="font-semibold">
                    {formatDay(invoice.dueDate)} · {formatPrice(invoice.amountCents)}
                  </p>
                  <p className="text-xs text-ink-2">
                    {invoice.number}
                    {invoice.paidAt
                      ? ` · paga em ${formatDateTime(invoice.paidAt)}${invoice.method ? ` via ${paymentMethodLabels[invoice.method]}` : ""}`
                      : null}
                  </p>
                </div>
                <Chip tone={view.tone}>{view.label}</Chip>
              </li>
            );
          })}
        </ul>
      )}

      <Link
        href={`/empresas?empresa=${subscription.companyId}`}
        className={buttonVariants({ className: "self-start" })}
      >
        Abrir empresa
      </Link>
    </>
  );
}
