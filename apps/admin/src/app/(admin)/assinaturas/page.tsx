import { buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { cn } from "@duckzap/ui/cn";
import type { Metadata } from "next";
import Link from "next/link";
import { ListFilters } from "@/components/list-filters";
import { Pagination } from "@/components/pagination";
import { UrlDrawer } from "@/components/url-drawer";
import {
  getSubscription,
  getSubscriptionCounts,
  listInvoices,
  listSubscriptions,
} from "@/features/subscriptions/api";
import { InvoiceList } from "@/features/subscriptions/components/invoice-list";
import {
  cycleLabels,
  isSubscriptionFilterSlug,
  subscriptionFilterLabels,
  subscriptionFilterOrder,
  subscriptionFilterSlugs,
  subscriptionStatusView,
  type SubscriptionFilterSlug,
} from "@/features/subscriptions/view";
import { formatDay, formatPrice, plural } from "@/lib/format";
import { hrefWith, pageParam, param, type SearchParams } from "@/lib/url";

export const metadata: Metadata = { title: "Assinaturas" };

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const statusParam = param(params, "status");
  const slug: SubscriptionFilterSlug = isSubscriptionFilterSlug(statusParam)
    ? statusParam
    : "todas";
  const search = (param(params, "q") ?? "").slice(0, 100);
  const openId = param(params, "assinatura");

  const [list, counts, open, invoices] = await Promise.all([
    listSubscriptions({
      filter: subscriptionFilterSlugs[slug],
      search,
      page: pageParam(param(params, "pagina")),
    }),
    getSubscriptionCounts(),
    openId ? getSubscription(openId) : Promise.resolve(null),
    openId ? listInvoices(openId) : Promise.resolve([]),
  ]);

  const options = subscriptionFilterOrder.map((value) => ({
    value,
    label: `${subscriptionFilterLabels[value]} · ${counts[subscriptionFilterSlugs[value]]}`,
  }));
  const filtered = slug !== "todas" || search !== "";

  return (
    <Page>
      <PageHeader
        title="Assinaturas"
        description="Planos contratados, valores, vencimentos e faturas de cada empresa."
      />

      {counts.late > 0 ? (
        <Alert
          tone="err"
          title={`${plural(counts.late, "assinatura com pagamento atrasado", "assinaturas com pagamento atrasado")}.`}
          action={
            slug !== "em-atraso" ? (
              <Link href="/assinaturas?status=em-atraso" className={buttonVariants({ size: "sm" })}>
                Ver em atraso
              </Link>
            ) : null
          }
        >
          Prorrogue ou fale com a empresa em Empresas. Depois de 30 dias a assinatura expira.
        </Alert>
      ) : null}

      <ListFilters
        filterKey="status"
        filterLabel="Filtro de assinaturas"
        options={options}
        defaultValue="todas"
        searchLabel="Buscar assinatura"
        searchPlaceholder="Buscar por empresa ou plano"
      />

      {list.items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <EmptyState
            icon="card"
            title={filtered ? "Nenhuma assinatura encontrada" : "Nenhuma assinatura ainda"}
            description={
              filtered
                ? "Tente outro filtro ou outra busca."
                : "As assinaturas aparecem quando as empresas contratam um plano."
            }
            action={
              filtered ? (
                <Link href="/assinaturas" className={buttonVariants({ size: "sm" })}>
                  Limpar filtros
                </Link>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <Table aria-label="Assinaturas" minWidth={980}>
            <thead>
              <tr>
                <Th>Empresa</Th>
                <Th>Plano</Th>
                <Th>Valor</Th>
                <Th>Ciclo</Th>
                <Th>Próximo vencimento</Th>
                <Th>Status</Th>
                <Th>Gateway</Th>
                <Th>
                  <span className="sr-only">Faturas</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((s) => {
                const status = subscriptionStatusView(s.status, s.daysPastDue);
                const late = s.status === "overdue" || s.status === "past_due";
                return (
                  <tr key={s.id} className={cn(late && "bg-err-bg/40")}>
                    <Td>
                      <Link
                        href={`/empresas?empresa=${s.companyId}`}
                        className="font-bold underline-offset-2 hover:underline"
                      >
                        {s.companyName}
                      </Link>
                    </Td>
                    <Td>{s.onTrial ? `Teste grátis · ${s.planName}` : s.planName}</Td>
                    <Td className="whitespace-nowrap">
                      {s.onTrial ? "Grátis" : formatPrice(s.amountCents)}
                    </Td>
                    <Td>{cycleLabels[s.cycle]}</Td>
                    <Td className={cn(late && "font-bold text-err")}>{formatDay(s.nextDueDate)}</Td>
                    <Td>
                      <Chip tone={status.tone}>{status.label}</Chip>
                    </Td>
                    <Td className="text-ink-2">{s.gateway ?? "[A DEFINIR]"}</Td>
                    <Td>
                      <Link
                        href={hrefWith("/assinaturas", params, { assinatura: s.id })}
                        scroll={false}
                        className={buttonVariants({ size: "sm" })}
                        aria-label={`Ver faturas: ${s.companyName}`}
                      >
                        Faturas
                      </Link>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination
            path="/assinaturas"
            params={params}
            page={list.page}
            pageCount={list.pageCount}
            total={list.total}
            noun={["assinatura", "assinaturas"]}
          />
        </>
      )}

      {openId ? (
        <UrlDrawer
          paramKey="assinatura"
          value={openId}
          title={open ? `Faturas · ${open.companyName}` : "Assinatura não encontrada"}
          description={
            open
              ? `${open.onTrial ? "Teste grátis · " : ""}${open.planName} · ${cycleLabels[open.cycle]} · ${open.onTrial ? "Grátis" : formatPrice(open.amountCents)}`
              : undefined
          }
        >
          {open ? (
            <InvoiceList subscription={open} invoices={invoices} />
          ) : (
            <EmptyState
              icon="card"
              title="Assinatura não encontrada"
              description="O link pode estar errado."
            />
          )}
        </UrlDrawer>
      ) : null}
    </Page>
  );
}
