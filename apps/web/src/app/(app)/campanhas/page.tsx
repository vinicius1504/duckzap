import type { Campaign } from "@duckzap/contracts/campaigns";
import { can } from "@duckzap/contracts/permissions";
import { isSendingPaused } from "@duckzap/contracts/session";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState, Progress } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/features/auth/permissions";
import {
  listCampaignHistory,
  listCampaignTemplates,
  listCampaigns,
  listRejectedRecipients,
} from "@/features/campaigns/api";
import { CampaignActions } from "@/features/campaigns/components/campaign-actions";
import { ExportCsvButton } from "@/features/campaigns/components/export-csv-button";
import { CampaignsPlanLock, PauseBanner, SendingPausedAlert } from "@/features/campaigns/components/notices";
import { RejectedTable } from "@/features/campaigns/components/recipients-table";
import { TemplatesPanel } from "@/features/campaigns/components/templates-panel";
import { UrlTabs } from "@/features/campaigns/components/url-tabs";
import { campaignStatusView, messageTypeLabel, sendBlockedReason } from "@/features/campaigns/labels";
import { formatDate, formatDuration } from "@/lib/format";

export const metadata: Metadata = { title: "Campanhas" };

export default async function CampaignsPage() {
  const session = await requirePermission("campaign.manage");
  const tz = session.organization.timeZone;
  const expired = isSendingPaused(session);
  // disparo/retomada: assinatura em dia + permissão campaign.send
  const blocked = sendBlockedReason(expired, can(session.user.role, "campaign.send"));

  if (!session.organization.features.includes("campaigns")) {
    return (
      <Page>
        <PageHeader title="Campanhas" description="Envie mensagens para listas de clientes que aceitaram receber." />
        <CampaignsPlanLock />
      </Page>
    );
  }

  const [campaigns, history, rejected, templates] = await Promise.all([
    listCampaigns(),
    listCampaignHistory(),
    listRejectedRecipients(),
    listCampaignTemplates(),
  ]);
  const running = campaigns.find((c) => c.status === "sending");
  const autoPaused = campaigns.filter((c) => c.status === "paused" && c.pauseReason && c.pauseReason !== "manual");

  const statusLabel = (c: Campaign) => {
    const view = campaignStatusView[c.status];
    if (c.status === "scheduled" && c.sending.scheduledAt) {
      return `${view.label} · ${formatDate(c.sending.scheduledAt, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }, tz)}`;
    }
    return view.label;
  };

  const list = campaigns.length ? (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-4">
        {autoPaused.map((c) => (
          <div key={c.id} className="flex flex-col gap-1">
            <p className="text-[13px] font-semibold">{c.name}</p>
            <PauseBanner campaign={c} />
          </div>
        ))}
        <Table minWidth={860}>
          <thead>
            <tr>
              <Th>Campanha</Th>
              <Th>Público</Th>
              <Th>Tipo</Th>
              <Th>Status</Th>
              <Th>Progresso</Th>
              <Th>
                <span className="sr-only">Ações</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link href={c.status === "draft" ? `/campanhas/nova?rascunho=${c.id}` : `/campanhas/${c.id}`} className="font-bold hover:underline">
                    {c.name}
                  </Link>
                  <p className="text-xs text-ink-2">{c.channelName ?? "Sem canal"}</p>
                </Td>
                <Td>{c.audienceName ?? "—"}</Td>
                <Td className="whitespace-nowrap">{messageTypeLabel[c.message.type]}</Td>
                <Td>
                  <Chip tone={campaignStatusView[c.status].tone}>{statusLabel(c)}</Chip>
                </Td>
                <Td className="w-40">
                  {c.status === "draft" ? (
                    <span className="text-ink-2">—</span>
                  ) : (
                    <>
                      <Progress value={c.stats.sent} max={Math.max(1, c.stats.total)} label={`Progresso de ${c.name}`} tone={c.status === "completed" ? "ok" : "ink"} />
                      <span className="mt-1 block text-xs text-ink-2">
                        {c.stats.sent} de {c.stats.total}
                      </span>
                    </>
                  )}
                </Td>
                <Td className="text-right">
                  <CampaignActions id={c.id} name={c.name} status={c.status} pauseReason={c.pauseReason} pauseDetail={c.pauseDetail} sendBlockedReason={blocked} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      {running ? <RunningCard campaign={running} timeZone={tz} blocked={blocked} /> : null}
    </div>
  ) : (
    <Card>
      <EmptyState
        icon="send"
        title="Nenhuma campanha ainda"
        description="Crie a primeira para avisar clientes que aceitaram receber mensagens: retorno, aniversário, promoções."
        action={
          <Link href="/campanhas/nova" className={buttonVariants({ variant: "primary" })}>
            Nova campanha
          </Link>
        }
      />
    </Card>
  );

  const historyHeader = ["Data", "Campanha", "Status", "Enviadas", "Falhas", "Respostas"] as const;
  const historyRows = history.map((c) => [
    c.finishedAt ? formatDate(c.finishedAt, { day: "2-digit", month: "2-digit", year: "numeric" }, tz) : "—",
    c.name,
    campaignStatusView[c.status].label,
    c.stats.sent,
    c.stats.failed,
    c.stats.replied,
  ]);

  const historyPanel = history.length ? (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <ExportCsvButton filename="historico-campanhas.csv" header={historyHeader} rows={historyRows} label="Exportar tudo" />
      </div>
      <Table minWidth={720}>
        <thead>
          <tr>
            {historyHeader.map((h) => (
              <Th key={h}>{h}</Th>
            ))}
            <Th>
              <span className="sr-only">Ações</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {history.map((c, i) => (
            <tr key={c.id}>
              <Td className="whitespace-nowrap">{historyRows[i]?.[0]}</Td>
              <Td>
                <Link href={`/campanhas/${c.id}`} className="font-bold hover:underline">
                  {c.name}
                </Link>
              </Td>
              <Td>
                <Chip tone={campaignStatusView[c.status].tone}>{campaignStatusView[c.status].label}</Chip>
              </Td>
              <Td className="tabular-nums">{c.stats.sent}</Td>
              <Td className="tabular-nums">{c.stats.failed}</Td>
              <Td className="tabular-nums">{c.stats.replied}</Td>
              <Td className="text-right">
                <ExportCsvButton filename={`campanha-${c.id}.csv`} header={historyHeader} rows={[historyRows[i] ?? []]} />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  ) : (
    <Card>
      <EmptyState icon="history" title="Nada no histórico ainda" description="Campanhas concluídas ou canceladas aparecem aqui." />
    </Card>
  );

  return (
    <Page>
      <PageHeader
        title="Campanhas"
        description="Envie mensagens para listas de clientes que aceitaram receber."
        actions={
          <Link href="/campanhas/nova" className={buttonVariants({ variant: "primary" })}>
            <Icon name="plus" size={18} /> Nova campanha
          </Link>
        }
      />
      {expired ? <SendingPausedAlert /> : null}
      <UrlTabs
        label="Seções de campanhas"
        defaultValue="campanhas"
        tabs={[
          { value: "campanhas", label: "Campanhas", content: list },
          { value: "historico", label: "Histórico", content: historyPanel },
          { value: "rejeitados", label: "Rejeitados", badge: rejected.length, content: <RejectedTable rows={rejected} timeZone={tz} showCampaign /> },
          { value: "modelos", label: "Modelos", content: <TemplatesPanel templates={templates} /> },
        ]}
      />
    </Page>
  );
}

function RunningCard({ campaign, timeZone, blocked }: { campaign: Campaign; timeZone: string; blocked: string | null }) {
  const remaining = Math.max(0, campaign.stats.total - campaign.stats.sent - campaign.stats.failed);
  const next = campaign.nextSendAt ? formatDate(campaign.nextSendAt, { hour: "2-digit", minute: "2-digit" }, timeZone) : null;
  const isQr = campaign.channelKind === "whatsapp_qr";
  return (
    <Card className="flex min-w-0 flex-[1_1_280px] flex-col gap-3.5 p-5">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Em execução</CardTitle>
        <Chip tone="info">
          <span className="size-2 animate-pulse rounded-full bg-current" aria-hidden="true" />
          Enviando
        </Chip>
      </div>
      <Link href={`/campanhas/${campaign.id}`} className="font-bold hover:underline">
        {campaign.name}
      </Link>
      <Progress value={campaign.stats.sent} max={Math.max(1, campaign.stats.total)} label={`Progresso de ${campaign.name}`} tone="duck" />
      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: "Enviadas", value: campaign.stats.sent },
          { label: "Falhas", value: campaign.stats.failed },
          { label: "Restantes", value: remaining },
        ].map((s) => (
          <div key={s.label} className="flex flex-col-reverse rounded-control bg-surface-2 py-2">
            <dt className="text-xs text-ink-2">{s.label}</dt>
            <dd className="text-xl font-extrabold tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
      {isQr ? (
        <p className="text-[13px] text-ink-2">
          {next ? `Próxima mensagem às ${next}` : "Aguardando a janela de envio"} · intervalo aleatório entre{" "}
          {formatDuration(campaign.sending.intervalMinSeconds)} e {formatDuration(campaign.sending.intervalMaxSeconds)}
        </p>
      ) : null}
      {campaign.dayPlan.length > 1 ? (
        <p className="text-[13px] text-ink-2">
          Dividida em {campaign.dayPlan.length} dias ({campaign.dayPlan.map((d) => d.count).join(" + ")}) para respeitar o limite do número.
        </p>
      ) : null}
      <CampaignActions
        id={campaign.id}
        name={campaign.name}
        status={campaign.status}
        pauseReason={campaign.pauseReason}
        pauseDetail={campaign.pauseDetail}
        sendBlockedReason={blocked}
        layout="detail"
      />
    </Card>
  );
}
