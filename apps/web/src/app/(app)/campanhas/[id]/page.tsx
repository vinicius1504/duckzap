import { can } from "@duckzap/contracts/permissions";
import { isSendingPaused } from "@duckzap/contracts/session";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Progress } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/features/auth/permissions";
import { getCampaign, listCampaignRecipients, listRejectedRecipients } from "@/features/campaigns/api";
import { CampaignActions } from "@/features/campaigns/components/campaign-actions";
import { CampaignsPlanLock, PauseBanner, SendingPausedAlert } from "@/features/campaigns/components/notices";
import { PhonePreview } from "@/features/campaigns/components/phone-preview";
import { RejectedTable, SendLogTable } from "@/features/campaigns/components/recipients-table";
import { UrlTabs } from "@/features/campaigns/components/url-tabs";
import { campaignStatusView, messageTypeLabel, sendBlockedReason } from "@/features/campaigns/labels";
import { toLocalInput } from "@/features/campaigns/time";
import { formatDate, formatDuration } from "@/lib/format";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const campaign = await getCampaign((await params).id);
  return { title: campaign?.name ?? "Campanha" };
}

export default async function CampaignDetailPage({ params }: Params) {
  const session = await requirePermission("campaign.manage");
  if (!session.organization.features.includes("campaigns")) {
    return (
      <Page>
        <CampaignsPlanLock />
      </Page>
    );
  }
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();
  if (campaign.status === "draft") redirect(`/campanhas/nova?rascunho=${campaign.id}`);

  const [log, rejected] = await Promise.all([listCampaignRecipients(id), listRejectedRecipients(id)]);
  const tz = session.organization.timeZone;
  const expired = isSendingPaused(session);
  const blocked = sendBlockedReason(expired, can(session.user.role, "campaign.send"));
  const isQr = campaign.channelKind === "whatsapp_qr";
  const { stats } = campaign;
  const remaining = Math.max(0, stats.total - stats.sent - stats.failed);
  const status = campaignStatusView[campaign.status];
  const dt = (iso: string | null) =>
    iso ? formatDate(iso, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }, tz) : "—";
  const today = toLocalInput(new Date().toISOString(), tz).slice(0, 10);

  const kpis = [
    { label: "Enviadas", value: stats.sent },
    { label: "Entregues", value: stats.delivered },
    { label: "Respostas", value: stats.replied },
    { label: "Falhas", value: stats.failed },
    { label: "Pediram para sair", value: stats.optedOut },
    { label: "Restantes", value: campaign.status === "completed" || campaign.status === "canceled" ? 0 : remaining },
  ];

  const settings = [
    { label: "Público", value: campaign.audienceName ?? "—" },
    { label: "Número", value: `${campaign.channelName ?? "—"} · ${isQr ? "QR Code" : "API oficial"}` },
    { label: "Tipo", value: messageTypeLabel[campaign.message.type] },
    ...(isQr
      ? [
          { label: "Variações", value: `${campaign.variations.filter((v) => v.review === "approved").length} aprovadas · ${campaign.variationMode === "bank" ? "sorteio do banco" : "nova a cada mensagem"}` },
          { label: "Intervalo", value: `aleatório entre ${formatDuration(campaign.sending.intervalMinSeconds)} e ${formatDuration(campaign.sending.intervalMaxSeconds)}` },
        ]
      : []),
    { label: "Janela", value: `${campaign.sending.windowStart} às ${campaign.sending.windowEnd}${campaign.sending.skipSundaysAndHolidays ? ", sem domingos e feriados" : ""}` },
    { label: "Criada", value: dt(campaign.createdAt) },
    { label: campaign.status === "scheduled" ? "Agendada para" : "Início", value: dt(campaign.status === "scheduled" ? campaign.sending.scheduledAt : campaign.startedAt) },
    ...(campaign.finishedAt ? [{ label: campaign.status === "canceled" ? "Cancelada" : "Concluída", value: dt(campaign.finishedAt) }] : []),
  ];

  const summary = (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[2_1_480px] flex-col gap-6">
        {campaign.dayPlan.length ? (
          <Card className="p-5">
            <CardTitle>Divisão por dia</CardTitle>
            <p className="mt-1 text-[13px] text-ink-2">
              {stats.total} pessoas → {campaign.dayPlan.length} {campaign.dayPlan.length === 1 ? "dia" : "dias"} ({campaign.dayPlan.map((d) => d.count).join(" + ")}), respeitando o limite do número.
            </p>
            <ol className="mt-3 flex flex-col gap-2 text-[13px]">
              {campaign.dayPlan.map((d) => (
                <li key={d.date} className="flex items-center justify-between gap-2 border-b border-line pb-2 last:border-0">
                  <span className="capitalize">{formatDate(d.date, { weekday: "long", day: "2-digit", month: "2-digit" }, tz)}</span>
                  <span className="flex items-center gap-2">
                    {d.date < today ? <Chip tone="ok">Enviado</Chip> : d.date === today ? <Chip tone="info">Hoje</Chip> : null}
                    <strong>{d.count}</strong>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        ) : null}
        <Card className="p-5">
          <CardTitle>Configuração</CardTitle>
          <dl className="mt-2 divide-y divide-line">
            {settings.map((s) => (
              <div key={s.label} className="flex flex-wrap gap-x-4 gap-y-0.5 py-2.5">
                <dt className="w-32 shrink-0 text-[13px] text-ink-2">{s.label}</dt>
                <dd className="min-w-0 flex-1 font-semibold">{s.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
      <div className="flex-[0_1_300px] max-md:mx-auto">
        <PhonePreview message={campaign.message} text={isQr ? undefined : campaign.message.body} senderName={session.organization.name} />
      </div>
    </div>
  );

  return (
    <Page>
      <Link href="/campanhas" className="inline-flex min-h-11 items-center gap-1.5 self-start text-[13px] font-semibold text-ink-2 hover:text-ink">
        <Icon name="arrowLeft" size={16} /> Campanhas
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">{campaign.name}</h1>
            <Chip tone={status.tone}>{status.label}</Chip>
          </div>
          <p className="mt-1 text-ink-2">
            {campaign.audienceName} · {campaign.channelName}
          </p>
        </div>
        <CampaignActions
          id={campaign.id}
          name={campaign.name}
          status={campaign.status}
          pauseReason={campaign.pauseReason}
          pauseDetail={campaign.pauseDetail}
          sendBlockedReason={blocked}
          layout="detail"
        />
      </div>

      {expired ? <SendingPausedAlert /> : null}
      {campaign.status === "paused" ? <PauseBanner campaign={campaign} /> : null}

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Progresso</CardTitle>
          <span className="text-[13px] text-ink-2">
            {stats.sent} de {stats.total}
            {campaign.status === "sending" && campaign.nextSendAt && isQr
              ? ` · próxima mensagem às ${formatDate(campaign.nextSendAt, { hour: "2-digit", minute: "2-digit" }, tz)}`
              : ""}
          </span>
        </div>
        <Progress value={stats.sent} max={Math.max(1, stats.total)} label="Progresso do envio" tone={campaign.status === "completed" ? "ok" : "duck"} />
        <dl className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(120px,100%),1fr))]">
          {kpis.map((k) => (
            <div key={k.label} className="flex flex-col-reverse rounded-control bg-surface-2 p-3">
              <dt className="text-xs text-ink-2">{k.label}</dt>
              <dd className="text-2xl font-extrabold tabular-nums">{k.value.toLocaleString("pt-BR")}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[13px] text-ink-2">Quem responde sai da campanha e vira uma conversa normal, com o agente ou a equipe.</p>
      </Card>

      <UrlTabs
        label="Detalhes da campanha"
        defaultValue="resumo"
        tabs={[
          { value: "resumo", label: "Resumo", content: summary },
          { value: "envios", label: "Envios", badge: log.length, content: <SendLogTable rows={log} timeZone={tz} usesVariations={isQr} /> },
          { value: "rejeitados", label: "Rejeitados", badge: rejected.length, content: <RejectedTable rows={rejected} timeZone={tz} /> },
        ]}
      />
    </Page>
  );
}
