import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import { requirePermission } from "@/features/auth/permissions";
import { getCopilotOverview, listAgentChannels, listAgents } from "@/features/agents/api";
import { AgentCards } from "@/features/agents/components/agent-list";
import { CopilotCard } from "@/features/agents/components/copilot-card";
import { FollowUpPreviewCard } from "@/features/agents/components/follow-up-preview-card";
import { CreateAgentDialog } from "@/features/agents/components/create-agent-dialog";

export const metadata: Metadata = { title: "Agentes de IA" };

export default async function AgentsPage() {
  const session = await requirePermission("agent.manage");
  const { features, maxAgents } = session.organization;
  const [agents, channels, copilot] = await Promise.all([listAgents(), listAgentChannels(), getCopilotOverview()]);
  // maxAgents null = ilimitado
  const limitReached = maxAgents !== null && agents.length >= maxAgents;
  const usage = maxAgents !== null ? `${agents.length} de ${maxAgents} ${maxAgents === 1 ? "agente" : "agentes"}` : "Agentes ilimitados no seu plano";

  return (
    <Page>
      <PageHeader
        title="Agentes de IA"
        description="Cada agente tem um trabalho: atender, retomar conversas, agendar ou responder no Instagram."
        actions={<CreateAgentDialog channels={channels} instagramAvailable={features.includes("instagram")} limitReached={limitReached} />}
      />
      <div className="mb-6">
        <FollowUpPreviewCard />
      </div>
      {/* fora das colunas: com o chip só na coluna da esquerda, o Copiloto ficava mais alto que a lista */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip tone={limitReached ? "warn" : "neutral"}>{usage}</Chip>
        {limitReached ? <span className="text-[13px] text-ink-2">Mude para o Pro para criar mais agentes.</span> : null}
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[3_1_560px] flex-col gap-3">
          {agents.length ? (
            <AgentCards agents={agents} />
          ) : (
            <Card>
              <EmptyState
                icon="bot"
                title="Nenhum agente ainda"
                description="Crie o primeiro para responder clientes na hora e chamar a equipe quando precisar."
                action={<CreateAgentDialog channels={channels} instagramAvailable={features.includes("instagram")} limitReached={false} />}
              />
            </Card>
          )}
        </div>
        <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <CopilotCard copilot={copilot} available={features.includes("copilot")} timeZone={session.organization.timeZone} />
        </aside>
      </div>
    </Page>
  );
}
