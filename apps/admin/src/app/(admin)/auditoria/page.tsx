import { buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import { ListFilters } from "@/components/list-filters";
import { Pagination } from "@/components/pagination";
import { listAuditEntries } from "@/features/audit/api";
import {
  auditActionView,
  auditFilterSlugs,
  describeChanges,
  isAuditFilterSlug,
  type AuditFilterSlug,
} from "@/features/audit/view";
import { getCompanyDetail } from "@/features/companies/api";
import { formatDateTime } from "@/lib/format";
import { hrefWith, pageParam, param, type SearchParams } from "@/lib/url";

export const metadata: Metadata = { title: "Auditoria" };

const options = [
  { value: "todas", label: "Todas" },
  { value: "empresas", label: "Empresas" },
  { value: "planos", label: "Planos" },
] as const satisfies readonly { value: AuditFilterSlug; label: string }[];

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const typeParam = param(params, "tipo");
  const slug: AuditFilterSlug = isAuditFilterSlug(typeParam) ? typeParam : "todas";
  const search = (param(params, "q") ?? "").slice(0, 100);
  const companyId = param(params, "empresa");

  const [list, company] = await Promise.all([
    listAuditEntries({
      filter: auditFilterSlugs[slug],
      search,
      companyId,
      page: pageParam(param(params, "pagina")),
    }),
    companyId ? getCompanyDetail(companyId) : Promise.resolve(null),
  ]);
  const filtered = slug !== "todas" || search !== "" || Boolean(companyId);

  return (
    <Page>
      <PageHeader
        title="Auditoria"
        description="Tudo o que a equipe fez no painel: quem, o quê, em qual empresa, por quê e quando. O registro não pode ser editado."
      />

      {companyId ? (
        <Alert
          tone="info"
          title="Filtrando por empresa:"
          action={
            <Link
              href={hrefWith("/auditoria", params, { empresa: null, pagina: null })}
              className={buttonVariants({ size: "sm" })}
            >
              <Icon name="close" size={14} /> Ver todas
            </Link>
          }
        >
          {company?.company.name ?? "empresa não encontrada"}
        </Alert>
      ) : null}

      <ListFilters
        filterKey="tipo"
        filterLabel="Tipo de ação"
        options={options}
        defaultValue="todas"
        searchLabel="Buscar na auditoria"
        searchPlaceholder="Buscar por pessoa, empresa ou motivo"
      />

      {list.items.length === 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <EmptyState
            icon="history"
            title={filtered ? "Nada encontrado" : "Nenhuma ação registrada ainda"}
            description={
              filtered
                ? "Tente outro filtro ou outra busca."
                : "Quando alguém alterar um plano ou uma empresa, a ação aparece aqui."
            }
            action={
              filtered ? (
                <Link href="/auditoria" className={buttonVariants({ size: "sm" })}>
                  Limpar filtros
                </Link>
              ) : null
            }
          />
        </div>
      ) : (
        <>
          <Table aria-label="Registro de auditoria" minWidth={960}>
            <thead>
              <tr>
                <Th>Quando</Th>
                <Th>Quem</Th>
                <Th>O que</Th>
                <Th>Empresa ou plano</Th>
                <Th>Motivo</Th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((entry) => {
                const view = auditActionView[entry.action];
                return (
                  <tr key={entry.id} className="align-top">
                    <Td className="whitespace-nowrap align-top text-[13px]">
                      <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                      {entry.ip ? (
                        <span className="block text-xs text-ink-2">IP {entry.ip}</span>
                      ) : null}
                    </Td>
                    <Td className="align-top">
                      <span className="font-semibold">{entry.actor.name}</span>
                      <span className="block text-xs text-ink-2">{entry.actor.email}</span>
                    </Td>
                    <Td className="align-top">
                      <Chip tone={view.tone}>{view.label}</Chip>
                      <span className="mt-1 block text-[13px]">{describeChanges(entry)}</span>
                    </Td>
                    <Td className="align-top">
                      {entry.company ? (
                        <Link
                          href={`/empresas?empresa=${entry.company.id}`}
                          className="font-semibold underline-offset-2 hover:underline"
                        >
                          {entry.company.name}
                        </Link>
                      ) : (
                        <span>
                          <span className="font-semibold">{entry.target.name}</span>
                          <span className="block text-xs text-ink-2">Plano</span>
                        </span>
                      )}
                    </Td>
                    <Td className="max-w-80 align-top text-[13px] text-ink-2">{entry.reason}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination
            path="/auditoria"
            params={params}
            page={list.page}
            pageCount={list.pageCount}
            total={list.total}
            noun={["registro", "registros"]}
          />
        </>
      )}
    </Page>
  );
}
