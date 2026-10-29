import { can, type Permission } from "@duckzap/contracts/permissions";
import { settingsTabSchema, type SettingsTab } from "@duckzap/contracts/settings";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { cn } from "@duckzap/ui/cn";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/features/auth/session";
import {
  getAccount,
  getBilling,
  getCompany,
  getIntegrations,
  getServiceSettings,
  listApiKeys,
  listWebhooks,
} from "@/features/settings/api";
import { AccountPanel } from "@/features/settings/components/account-panel";
import { BillingPanel } from "@/features/settings/components/billing-panel";
import { CompanyForm } from "@/features/settings/components/company-form";
import { ApiKeysSection, WebhooksSection } from "@/features/settings/components/developer-sections";
import { IntegrationCards } from "@/features/settings/components/integration-cards";
import { ServiceForm } from "@/features/settings/components/service-form";

export const metadata: Metadata = { title: "Ajustes" };

const tabs: { value: SettingsTab; label: string; permission?: Permission }[] = [
  { value: "empresa", label: "Empresa", permission: "settings.manage" },
  { value: "atendimento", label: "Atendimento", permission: "settings.manage" },
  { value: "integracoes", label: "Integrações", permission: "integration.manage" },
  { value: "plano", label: "Plano e cobrança", permission: "billing.manage" },
  { value: "conta", label: "Minha conta" },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const session = await requireSession();
  const allowed = tabs.filter((t) => !t.permission || can(session.user.role, t.permission));
  const requested = (await searchParams).aba;
  const parsed = settingsTabSchema.safeParse(requested);
  // aba que o papel não pode abrir (ou inválida) volta para Minha conta
  if (requested !== undefined && (!parsed.success || !allowed.some((t) => t.value === parsed.data))) redirect("/ajustes?aba=conta");
  const tab: SettingsTab = parsed.success ? parsed.data : (allowed[0]?.value ?? "conta");
  const tz = session.organization.timeZone;

  return (
    <Page className="max-w-275 gap-[18px]">
      <PageHeader title="Configurações" description="Ajustes da empresa, do atendimento, das integrações e da sua conta." />

      {/* overflow-y-hidden + pb-px: o -mb-px das abas passava 1px do fundo e o navegador mostrava uma rolagem vertical */}
      <nav aria-label="Seções das configurações" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line pb-px">
        {allowed.map((t) => (
          <Link
            key={t.value}
            href={`/ajustes?aba=${t.value}`}
            aria-current={t.value === tab ? "page" : undefined}
            className={cn(
              "-mb-px flex h-11 shrink-0 items-center whitespace-nowrap border-b-[3px] border-transparent px-4 font-semibold text-ink-2",
              t.value === tab && "border-duck text-ink",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "empresa" ? <CompanyForm company={await getCompany()} /> : null}
      {tab === "atendimento" ? <ServiceForm settings={await getServiceSettings()} /> : null}
      {tab === "integracoes" ? <IntegrationsTab timeZone={tz} /> : null}
      {tab === "plano" ? <BillingPanel billing={await getBilling()} timeZone={tz} /> : null}
      {tab === "conta" ? <AccountPanel account={await getAccount(session.user.id)} timeZone={tz} /> : null}
    </Page>
  );
}

async function IntegrationsTab({ timeZone }: { timeZone: string }) {
  const [integrations, apiKeys, webhooks] = await Promise.all([getIntegrations(), listApiKeys(), listWebhooks()]);
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))]">
      <IntegrationCards integrations={integrations} timeZone={timeZone} />
      <ApiKeysSection apiKeys={apiKeys} timeZone={timeZone} />
      <WebhooksSection webhooks={webhooks} timeZone={timeZone} />
    </div>
  );
}
