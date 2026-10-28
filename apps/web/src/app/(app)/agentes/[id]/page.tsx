import { INSTAGRAM_JOBS } from "@duckzap/contracts/agents";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/features/auth/permissions";
import { getAgent, getCopilotOverview, listAgentVersions } from "@/features/agents/api";
import { AgentEditor } from "@/features/agents/components/agent-editor";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const agent = await getAgent((await params).id);
  return { title: agent?.config.name ?? "Agente" };
}

export default async function AgentDetailPage({ params }: Params) {
  const session = await requirePermission("agent.manage");
  const { id } = await params;
  const [agent, versions, copilot] = await Promise.all([getAgent(id), listAgentVersions(id), getCopilotOverview()]);
  if (!agent) notFound();

  const instagramLocked = INSTAGRAM_JOBS.includes(agent.job) && !session.organization.features.includes("instagram");
  const activationBlocked = instagramLocked
    ? "Instagram faz parte dos planos Pro e Empresarial. Este agente fica pausado até mudar de plano."
    : !agent.channels.length
      ? "Vincule o agente a um canal em Canais antes de ativar."
      : null;

  const header = (
    <div className="flex flex-col gap-3">
      <Link href="/agentes" className={buttonVariants({ className: "self-start max-md:h-11" })}>
        <Icon name="arrowLeft" size={16} /> Agentes
      </Link>
      {instagramLocked ? (
        <Alert
          tone="warn"
          title="Recurso dos planos Pro e Empresarial"
          action={
            <Link href="/ajustes?aba=plano" className="text-[13px] font-semibold underline underline-offset-2">
              Ver planos
            </Link>
          }
        >
          Você pode editar e testar no simulador, mas o agente só volta a responder no Instagram nos planos Pro e Empresarial.
        </Alert>
      ) : null}
    </div>
  );

  return (
    <Page>
      <AgentEditor
        key={agent.id}
        agent={agent}
        versions={versions}
        copilot={copilot}
        copilotAvailable={session.organization.features.includes("copilot")}
        timeZone={session.organization.timeZone}
        activationBlocked={activationBlocked}
        header={header}
      />
    </Page>
  );
}
