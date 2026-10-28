import type { Plan } from "@duckzap/contracts/admin";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState, Progress } from "@duckzap/ui/components/feedback";
import Link from "next/link";
import type { ReactNode } from "react";
import { describeChanges, auditActionView } from "@/features/audit/view";
import { invoiceStatusView } from "@/features/subscriptions/view";
import { formatCnpj, formatDateTime, formatDay, formatPhone, formatPrice } from "@/lib/format";
import type { CompanyDetail } from "../api";
import { companyStatusView } from "../view";
import { CompanyActions } from "./company-actions";

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Usage({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  return (
    <div className="text-[13px]">
      <div className="mb-1 flex justify-between gap-3">
        <span>{label}</span>
        <span className={used > (limit ?? Infinity) ? "font-bold text-err" : "text-ink-2"}>
          {limit === null ? `${used} · ilimitados` : `${used} de ${limit}`}
        </span>
      </div>
      {limit === null ? null : (
        <Progress
          label={`${label}: ${used} de ${limit}`}
          value={Math.min(used, limit)}
          max={limit}
          tone={used > limit ? "err" : used === limit ? "duck" : "ink"}
        />
      )}
    </div>
  );
}

/** Corpo da gaveta da empresa (Server Component; as ações são ilhas client). */
export function CompanyDetailBody({ detail, plans }: { detail: CompanyDetail; plans: Plan[] }) {
  const { company, invoices, history, subscriptionId } = detail;
  const status = companyStatusView(company.status, company.daysPastDue);
  const plan = plans.find((p) => p.id === company.planId);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={status.tone}>{status.label}</Chip>
        <Chip>{company.onTrial ? `Teste grátis · ${company.planName}` : company.planName}</Chip>
      </div>

      <CompanyActions company={company} plans={plans} variant="full" />

      <Section title="Contato">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="text-ink-2">Responsável</dt>
          <dd className="font-semibold">{company.ownerName}</dd>
          <dt className="text-ink-2">E-mail</dt>
          <dd className="break-all">
            <a href={`mailto:${company.email}`} className="underline">
              {company.email}
            </a>
          </dd>
          <dt className="text-ink-2">Telefone</dt>
          <dd>{formatPhone(company.phone)}</dd>
          <dt className="text-ink-2">CNPJ</dt>
          <dd>{formatCnpj(company.document)}</dd>
          <dt className="text-ink-2">Cidade</dt>
          <dd>{company.city}</dd>
          <dt className="text-ink-2">Segmento</dt>
          <dd>{company.segment}</dd>
          <dt className="text-ink-2">Cliente desde</dt>
          <dd>{formatDay(company.createdAt)}</dd>
        </dl>
      </Section>

      <Section title="Plano e uso">
        <p className="text-[13px] text-ink-2">
          {company.onTrial ? "Fim do teste" : "Próximo vencimento"}:{" "}
          <strong className="text-ink">{formatDay(company.dueDate)}</strong>
          {plan ? ` · ${formatPrice(plan.recurringPriceCents)} / mês` : null}
        </p>
        <Usage label="Canais" used={company.usage.channels} limit={plan?.limits.channels ?? null} />
        <Usage label="Usuários" used={company.usage.users} limit={plan?.limits.users ?? null} />
        <Usage label="Agentes" used={company.usage.agents} limit={plan?.limits.agents ?? null} />
      </Section>

      <Section
        title="Faturas recentes"
        action={
          <Link
            href={`/assinaturas?assinatura=${subscriptionId}`}
            className="text-[13px] font-bold underline"
          >
            Ver assinatura
          </Link>
        }
      >
        {invoices.length ? (
          <ul className="flex flex-col text-[13px]">
            {invoices.map((invoice) => {
              const view = invoiceStatusView[invoice.status];
              return (
                <li
                  key={invoice.id}
                  className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0"
                >
                  <span>
                    <span className="font-semibold">{formatDay(invoice.dueDate)}</span>
                    <span className="text-ink-2"> · {formatPrice(invoice.amountCents)}</span>
                  </span>
                  <Chip tone={view.tone}>{view.label}</Chip>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-2">
            {company.onTrial ? "Nenhuma fatura durante o teste." : "Nenhuma fatura ainda."}
          </p>
        )}
      </Section>

      <Section
        title="Histórico no painel"
        action={
          <Link
            href={`/auditoria?empresa=${company.id}`}
            className="text-[13px] font-bold underline"
          >
            Ver tudo
          </Link>
        }
      >
        {history.length ? (
          <ol className="flex flex-col gap-3 text-[13px]">
            {history.map((entry) => (
              <li key={entry.id} className="rounded-control bg-bg p-3">
                <p>
                  <strong>{auditActionView[entry.action].label}</strong> · {describeChanges(entry)}
                </p>
                <p className="mt-0.5 text-ink-2">“{entry.reason}”</p>
                <p className="mt-1 text-xs text-ink-2">
                  {entry.actor.name} · {formatDateTime(entry.at)}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            icon="history"
            title="Nenhuma ação registrada"
            description="Alterações feitas aqui aparecem nesta lista."
          />
        )}
      </Section>
    </>
  );
}
