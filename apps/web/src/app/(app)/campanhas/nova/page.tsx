import { DEFAULT_OPT_OUT_LINE, type CampaignDraftInput } from "@duckzap/contracts/campaigns";
import { can } from "@duckzap/contracts/permissions";
import { isSendingPaused } from "@duckzap/contracts/session";
import { Icon } from "@duckzap/ui/components/icon";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/features/auth/permissions";
import { getCampaign, getCampaignTerms, listAudiences, listCampaignTemplates, listSendingChannels } from "@/features/campaigns/api";
import { CampaignsPlanLock, SendingPausedAlert } from "@/features/campaigns/components/notices";
import { CampaignWizard } from "@/features/campaigns/components/wizard/campaign-wizard";
import { sendBlockedReason } from "@/features/campaigns/labels";

export const metadata: Metadata = { title: "Nova campanha" };

const searchSchema = z.object({
  rascunho: z.string().max(64).optional().catch(undefined),
  modelo: z.string().max(64).optional().catch(undefined),
});

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission("campaign.manage");
  const header = (
    <>
      <Link href="/campanhas" className="inline-flex min-h-11 items-center gap-1.5 self-start text-[13px] font-semibold text-ink-2 hover:text-ink">
        <Icon name="arrowLeft" size={16} /> Campanhas
      </Link>
      <PageHeader title="Nova campanha" description="Quatro passos: público, mensagem, envio e revisão." />
    </>
  );
  if (!session.organization.features.includes("campaigns")) {
    return (
      <Page>
        {header}
        <CampaignsPlanLock />
      </Page>
    );
  }

  const { rascunho, modelo } = searchSchema.parse(await searchParams);
  const [audiences, channels, templates, terms, existing] = await Promise.all([
    listAudiences(),
    listSendingChannels(),
    listCampaignTemplates(),
    getCampaignTerms(),
    rascunho ? getCampaign(rascunho) : Promise.resolve(null),
  ]);
  if (rascunho && !existing) notFound();
  if (existing && existing.status !== "draft") redirect(`/campanhas/${existing.id}`);

  const template = modelo ? templates.find((t) => t.id === modelo && t.source === "internal") : undefined;
  const defaultChannel = channels.find((c) => c.connected && c.kind === "whatsapp_qr") ?? channels.find((c) => c.connected);

  const initialDraft: CampaignDraftInput = existing
    ? {
        name: existing.name,
        audienceId: existing.audienceId,
        message: existing.message,
        variationMode: existing.variationMode,
        variations: existing.variations,
        variationsBase: existing.variationsBase,
        sending: existing.sending,
      }
    : {
        name: template?.name ?? "",
        audienceId: null,
        message: {
          type: template?.type ?? "text",
          body: template?.body ?? "",
          imageName: null,
          buttons: template?.buttons ?? [],
          listButtonLabel: "",
          listItems: [],
          optOutLine: DEFAULT_OPT_OUT_LINE,
          officialTemplateId: null,
        },
        variationMode: "bank",
        variations: [],
        variationsBase: null,
        sending: {
          channelId: defaultChannel?.id ?? "",
          scheduleMode: "now",
          scheduledAt: null,
          intervalMinSeconds: 45,
          intervalMaxSeconds: 120,
          windowStart: "08:00",
          windowEnd: "20:00",
          skipSundaysAndHolidays: true,
        },
      };

  const expired = isSendingPaused(session);

  return (
    <Page>
      {header}
      {expired ? <SendingPausedAlert /> : null}
      <CampaignWizard
        // um rascunho diferente na URL reinicia o estado do assistente
        key={existing?.id ?? `novo-${template?.id ?? ""}`}
        initialId={existing?.id ?? null}
        initialDraft={initialDraft}
        ctx={{
          audiences,
          channels,
          metaTemplates: templates.filter((t) => t.source === "meta"),
          terms,
          timeZone: session.organization.timeZone,
          companyName: session.organization.name,
          sendBlockedReason: sendBlockedReason(expired, can(session.user.role, "campaign.send")),
        }}
      />
    </Page>
  );
}
