import { buttonVariants } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { companyStatusView } from "@/features/companies/view";
import { getPlatformOverview } from "@/features/overview/api";
import { MrrLine, SignupBars } from "@/features/overview/components/charts";
import { formatDay, formatPrice } from "@/lib/format";

export const metadata: Metadata = { title: "Visão geral" };

export default async function OverviewPage() {
  const data = await getPlatformOverview();
  const kpis = [
    {
      label: "Empresas ativas",
      value: String(data.kpis.activeCompanies),
      href: "/empresas?status=em-dia",
    },
    {
      label: "Em teste",
      value: String(data.kpis.trialCompanies),
      href: "/empresas?status=em-teste",
    },
    {
      label: "Vencidas",
      value: String(data.kpis.overdueCompanies),
      href: "/assinaturas?status=em-atraso",
    },
    {
      label: "Receita estimada / mês",
      value: formatPrice(data.kpis.estimatedMonthlyRevenueCents),
      href: "/planos",
    },
  ];
  const signupsTotal = data.signupsPerWeek.reduce((sum, w) => sum + w.count, 0);
  const lastMrr = data.mrrTrend[data.mrrTrend.length - 1];

  return (
    <Page>
      <PageHeader
        title="Painel Admin"
        description="Visão geral da plataforma: empresas, assinaturas e receita."
      />

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
        {kpis.map((kpi) => (
          <Link key={kpi.label} href={kpi.href} className="rounded-card">
            <Card className="h-full p-[18px] hover:bg-surface-hover">
              <p className="text-[13px] text-ink-2">{kpi.label}</p>
              <p className="mt-1 text-[30px] font-extrabold">{kpi.value}</p>
            </Card>
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-6">
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Receita recorrente (MRR)</CardTitle>
              {data.mrrIsSample ? <Chip tone="warn">Valores de exemplo</Chip> : null}
            </div>
            <p className="text-[13px] text-ink-2">
              Últimos 6 meses
              {lastMrr ? ` · ${lastMrr.payingCompanies} empresas pagantes no mês atual` : null}
              {data.mrrIsSample ? " · os preços dos planos ainda estão [A DEFINIR]" : null}
            </p>
            {data.mrrTrend.length ? (
              <MrrLine data={data.mrrTrend} />
            ) : (
              <EmptyState icon="chart" title="Sem histórico ainda" />
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <CardTitle>Novas contas por semana</CardTitle>
              <span className="text-[13px] text-ink-2">{signupsTotal} em 8 semanas</span>
            </div>
            <SignupBars data={data.signupsPerWeek} />
          </Card>
        </div>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <Card className="px-5 pb-2 pt-5">
            <div className="mb-1.5 flex items-center justify-between">
              <CardTitle>Precisa de atenção</CardTitle>
              <Chip tone={data.needsAttention.length ? "warn" : "ok"}>
                {data.needsAttention.length
                  ? `${data.needsAttention.length} empresas`
                  : "Tudo em dia"}
              </Chip>
            </div>
            {data.needsAttention.length ? (
              <ul>
                {data.needsAttention.map((item) => {
                  const view = companyStatusView(item.status, item.daysPastDue);
                  return (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center gap-2 border-t border-line py-3"
                    >
                      <div className="min-w-0 flex-[1_1_160px]">
                        <Link
                          href={`/empresas?empresa=${item.id}`}
                          className="font-semibold underline-offset-2 hover:underline"
                        >
                          {item.name}
                        </Link>
                        <p className="text-[13px] text-ink-2">
                          {item.status === "trial" ? "Teste acaba em" : "Venceu em"}{" "}
                          {formatDay(item.dueDate)}
                        </p>
                      </div>
                      <Chip tone={view.tone}>
                        {item.status === "trial" ? "Teste acabando" : view.label}
                      </Chip>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="border-t border-line py-4 text-ink-2">
                Nenhuma empresa com pagamento atrasado.
              </p>
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <CardTitle>Cadastros recentes</CardTitle>
              <Link href="/empresas" className="text-[13px] font-bold underline">
                Ver empresas
              </Link>
            </div>
            {data.recentSignups.length ? (
              <ul className="mt-2">
                {data.recentSignups.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 border-t border-line py-3 first:border-t-0"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/empresas?empresa=${c.id}`}
                        className="font-semibold underline-offset-2 hover:underline"
                      >
                        {c.name}
                      </Link>
                      <p className="text-[13px] text-ink-2">{formatDay(c.createdAt)}</p>
                    </div>
                    <Chip tone={c.onTrial ? "info" : "neutral"}>
                      {c.onTrial ? "Em teste" : c.planName}
                    </Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon="building"
                title="Nenhum cadastro ainda"
                action={
                  <Link href="/empresas" className={buttonVariants({ size: "sm" })}>
                    Ver empresas
                  </Link>
                }
              />
            )}
          </Card>
        </aside>
      </div>
    </Page>
  );
}
