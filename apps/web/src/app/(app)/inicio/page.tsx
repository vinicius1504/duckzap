import { homePeriodSchema, type AttentionItem } from "@duckzap/contracts/home";
import { can } from "@duckzap/contracts/permissions";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import { Page } from "@duckzap/ui/components/layout";
import { cn } from "@duckzap/ui/cn";
import type { Metadata } from "next";
import Link from "next/link";
import { requireSession } from "@/features/auth/session";
import { getHomeOverview } from "@/features/home/api";
import { FunnelDonut, funnelColors } from "@/features/home/components/charts";
import { ConversationsLine } from "@/features/home/components/conversations-line";
import { PeriodFilter } from "@/features/home/components/period-filter";
import { TasksCard } from "@/features/home/components/tasks-card";
import { formatDate, formatDuration, greeting } from "@/lib/format";

export const metadata: Metadata = { title: "Início" };

const attention: Record<
  AttentionItem["kind"],
  { tag: string; tone: ChipTone; action: string; primary?: boolean }
> = {
  queue: { tag: "Aguardando", tone: "warn", action: "Ver conversas" },
  unanswered: { tag: "Sem resposta", tone: "info", action: "Responder" },
  channel_down: { tag: "Canal", tone: "err", action: "Reconectar", primary: true },
  appointments_to_confirm: { tag: "Agenda", tone: "neutral", action: "Confirmar" },
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ periodo?: string }>;
}) {
  const session = await requireSession();
  const period = homePeriodSchema.catch("today").parse((await searchParams).periodo);
  const data = await getHomeOverview(period);
  const tz = session.organization.timeZone;
  const now = new Date();
  const today = formatDate(
    now.toISOString(),
    { weekday: "long", day: "numeric", month: "long" },
    tz,
  );
  const firstName = session.user.name.split(" ")[0];
  // com dados reais pode não haver nada ainda: o piso em 1 evita divisão por zero nas barras
  const maxConversion = Math.max(1, ...data.weeklyConversion.map((w) => w.percent));
  const maxByAgent = Math.max(1, ...data.conversationsByAgent.map((a) => a.count));
  const kpis = [
    { label: "Conversas abertas", value: String(data.kpis.openConversations) },
    { label: "Novas hoje", value: String(data.kpis.newToday) },
    { label: "Primeira resposta", value: formatDuration(data.kpis.firstResponseSeconds) },
    { label: "Tempo de atendimento", value: formatDuration(data.kpis.handlingSeconds) },
  ];
  const aiPercent = data.kpis.resolvedByAiPercent;

  return (
    <Page>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">
            {greeting(now, tz)}, {firstName}
          </h1>
          <p className="mt-1 text-ink-2">
            {today.charAt(0).toUpperCase() + today.slice(1)} · {session.organization.name}
          </p>
        </div>
        <PeriodFilter />
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_620px] flex-col gap-6">
          <Card className="px-5 pb-2 pt-5">
            <div className="mb-1.5 flex items-center justify-between">
              <CardTitle>Precisa de você</CardTitle>
              <Chip tone={data.attention.length ? "warn" : "ok"}>
                {data.attention.length
                  ? `${data.attention.length} ${data.attention.length === 1 ? "item" : "itens"}`
                  : "Tudo em dia"}
              </Chip>
            </div>
            <ul>
              {data.attention.map((item) => {
                const view = attention[item.kind];
                return (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-3.5 border-t border-line py-3.5"
                  >
                    <Chip tone={view.tone} className="w-24 justify-center">
                      {view.tag}
                    </Chip>
                    <div className="flex-[1_1_240px]">
                      <strong>{item.title}</strong>
                      <p className="text-ink-2">{item.detail}</p>
                    </div>
                    <Link
                      href={item.href}
                      className={buttonVariants({
                        size: "sm",
                        variant: view.primary ? "primary" : "secondary",
                      })}
                    >
                      {view.action}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>

          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))]">
            {kpis.map((kpi) => (
              <Card key={kpi.label} className="p-4">
                <p className="text-[13px] text-ink-2">{kpi.label}</p>
                <p className="mt-1 text-[28px] font-extrabold">{kpi.value}</p>
              </Card>
            ))}
            <Card className="p-4">
              <p className="text-[13px] text-ink-2">Quem resolveu</p>
              <div className="mb-2 mt-3.5 flex h-3 overflow-hidden rounded-md" aria-hidden="true">
                <span className="bg-ink" style={{ width: `${aiPercent}%` }} />
                <span className="bg-duck" style={{ width: `${100 - aiPercent}%` }} />
              </div>
              <p className="text-[13px]">
                <strong>{aiPercent}%</strong> IA · <strong>{100 - aiPercent}%</strong> pessoas
              </p>
            </Card>
          </div>

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <CardTitle>Conversas por dia</CardTitle>
              <span className="text-[13px] text-ink-2">Últimos 7 dias</span>
            </div>
            <ConversationsLine data={data.conversationsPerDay} timeZone={tz} />
          </Card>

          <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr))]">
            <Card className="p-5">
              <CardTitle>Clientes por etapa</CardTitle>
              <div className="mt-3.5 flex flex-wrap items-center gap-5">
                <FunnelDonut data={data.funnel} />
                <ul className="flex flex-col gap-2 text-[13px]">
                  {data.funnel.map((slice, index) => (
                    <li key={slice.stage} className="flex items-center gap-2">
                      <span
                        className="size-3 rounded-[3px]"
                        style={{ background: funnelColors[index % funnelColors.length] }}
                      />
                      {slice.stage} <strong>{slice.percent}%</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
            <Card className="p-5">
              <CardTitle>Taxa de conversão</CardTitle>
              <p className="text-[13px] text-ink-2">Conversas que viraram agendamento ou venda</p>
              <ul className="mt-3.5 flex h-[136px] items-end gap-4">
                {data.weeklyConversion.map((week) => {
                  const best = week.percent === maxConversion;
                  return (
                    <li
                      key={week.label}
                      className="flex flex-1 flex-col items-center gap-1 text-xs"
                    >
                      <span className={cn(best && "font-bold")}>{week.percent}%</span>
                      <span
                        className={cn("w-full rounded-t-md", best ? "bg-duck" : "bg-field")}
                        style={{ height: `${(week.percent / maxConversion) * 80}px` }}
                        aria-hidden="true"
                      />
                      <span className="text-ink-2">{week.label}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </div>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <TasksCard tasks={data.tasks} />
          {can(session.user.role, "home.view_team_metrics") ? (
            <Card className="p-5">
              <CardTitle>Conversas por atendente</CardTitle>
              {data.conversationsByAgent.length === 0 ? (
                <p className="mt-2 text-[13px] text-ink-2">Ainda não há conversas atendidas neste período.</p>
              ) : null}
              <ul className="mt-3.5 flex flex-col gap-3.5 text-[13px]">
                {data.conversationsByAgent.map((agent) => (
                  <li key={agent.name}>
                    <div className="flex justify-between">
                      <span>{agent.name}</span>
                      <strong>{agent.count}</strong>
                    </div>
                    <div className="mt-1.5 h-2.5 rounded-[5px] bg-surface-2" aria-hidden="true">
                      <div
                        className={cn("h-2.5 rounded-[5px]", agent.isAi ? "bg-duck" : "bg-ink")}
                        style={{ width: `${(agent.count / maxByAgent) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </Page>
  );
}
