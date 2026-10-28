import { buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import { ListFilters } from "@/components/list-filters";
import { Pagination } from "@/components/pagination";
import { UrlDrawer } from "@/components/url-drawer";
import { getCompanyCounts, getCompanyDetail, listCompanies } from "@/features/companies/api";
import { CompanyActions } from "@/features/companies/components/company-actions";
import { CompanyDetailBody } from "@/features/companies/components/company-detail";
import {
  companyFilterLabels,
  companyFilterOrder,
  companyFilterSlugs,
  companyStatusView,
  isCompanyFilterSlug,
  type CompanyFilterSlug,
} from "@/features/companies/view";
import { listPlans } from "@/features/plans/api";
import { formatDay, plural } from "@/lib/format";
import { hrefWith, pageParam, param, type SearchParams } from "@/lib/url";

export const metadata: Metadata = { title: "Empresas" };

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const statusParam = param(params, "status");
  const slug: CompanyFilterSlug = isCompanyFilterSlug(statusParam) ? statusParam : "todas";
  const search = (param(params, "q") ?? "").slice(0, 100);
  const openId = param(params, "empresa");

  const [list, counts, plans, detail] = await Promise.all([
    listCompanies({
      filter: companyFilterSlugs[slug],
      search,
      page: pageParam(param(params, "pagina")),
    }),
    getCompanyCounts(),
    listPlans(),
    openId ? getCompanyDetail(openId) : Promise.resolve(null),
  ]);

  const options = companyFilterOrder.map((value) => ({
    value,
    label: `${companyFilterLabels[value]} · ${counts[companyFilterSlugs[value]]}`,
  }));
  const filtered = slug !== "todas" || search !== "";

  return (
    <Page>
      <PageHeader
        title="Empresas"
        description={`${plural(counts.all, "empresa cadastrada", "empresas cadastradas")} na plataforma`}
      />

      <ListFilters
        filterKey="status"
        filterLabel="Filtro rápido"
        options={options}
        defaultValue="todas"
        searchLabel="Buscar empresa"
        searchPlaceholder="Buscar por nome, e-mail ou CNPJ"
      />

      {list.items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <EmptyState
            icon="building"
            title={filtered ? "Nenhuma empresa encontrada" : "Nenhuma empresa ainda"}
            description={
              filtered
                ? "Tente outro filtro ou confira o que foi digitado na busca."
                : "Quando uma empresa criar a conta, ela aparece aqui."
            }
            action={
              filtered ? (
                <Link href="/empresas" className={buttonVariants({ size: "sm" })}>
                  Limpar filtros
                </Link>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <Table aria-label="Empresas">
            <thead>
              <tr>
                <Th>Empresa</Th>
                <Th>Plano</Th>
                <Th>Vencimento</Th>
                <Th>Status</Th>
                <Th>Ações</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((company) => {
                const status = companyStatusView(company.status, company.daysPastDue);
                return (
                  <tr key={company.id} className={company.enabled ? undefined : "text-ink-2"}>
                    <Td>
                      <Link
                        href={hrefWith("/empresas", params, { empresa: company.id })}
                        scroll={false}
                        className="font-bold text-ink underline-offset-2 hover:underline"
                      >
                        {company.name}
                      </Link>
                      <span className="block text-[13px] text-ink-2">{company.email}</span>
                    </Td>
                    <Td>{company.onTrial ? "Teste grátis" : company.planName}</Td>
                    <Td>{formatDay(company.dueDate)}</Td>
                    <Td>
                      <Chip tone={status.tone}>{status.label}</Chip>
                    </Td>
                    <Td>
                      <CompanyActions company={company} plans={plans} variant="row" />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination
            path="/empresas"
            params={params}
            page={list.page}
            pageCount={list.pageCount}
            total={list.total}
            noun={["empresa", "empresas"]}
          />
        </>
      )}

      {openId ? (
        <UrlDrawer
          paramKey="empresa"
          value={openId}
          title={detail?.company.name ?? "Empresa não encontrada"}
          description={detail ? detail.company.email : undefined}
        >
          {detail ? (
            <CompanyDetailBody detail={detail} plans={plans} />
          ) : (
            <EmptyState
              icon="building"
              title="Empresa não encontrada"
              description="O link pode estar errado ou a empresa foi removida."
            />
          )}
        </UrlDrawer>
      ) : null}
    </Page>
  );
}
