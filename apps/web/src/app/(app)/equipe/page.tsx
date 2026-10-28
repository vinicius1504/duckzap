import { can } from "@duckzap/contracts/permissions";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { cn } from "@duckzap/ui/cn";
import type { Metadata } from "next";
import { requirePermission } from "@/features/auth/permissions";
import { summarizeBusinessHours } from "@/features/settings/components/business-hours";
import { getTeamOverview } from "@/features/team/api";
import { teamColorClass } from "@/features/team/components/labels";
import { MemberDialog } from "@/features/team/components/member-dialog";
import { MembersTable } from "@/features/team/components/members-table";
import { TeamDialog } from "@/features/team/components/team-dialog";
import { TeamTabs } from "@/features/team/components/team-tabs";

export const metadata: Metadata = { title: "Equipe" };

export default async function TeamPage() {
  const session = await requirePermission("team.manage");
  const data = await getTeamOverview();
  const { members, teams, channels, agents, userLimit } = data;
  const limitReached = userLimit.max !== null && userLimit.used >= userLimit.max;
  const teamOptions = teams.map((t) => ({ id: t.id, name: t.name }));
  const firstName = (id: string) => members.find((m) => m.id === id)?.name.split(" ")[0];
  const names = (list: { id: string; name: string }[], ids: string[]) =>
    ids.map((id) => list.find((x) => x.id === id)?.name).filter(Boolean).join(", ") || "nenhum";
  const nextPriority = Math.max(0, ...teams.map((t) => t.priority)) + 1;
  const actor = { id: session.user.id, role: session.user.role };

  const people = members.length ? (
    <MembersTable members={members} teams={teamOptions} actor={actor} limitReached={limitReached} />
  ) : (
    <Card>
      <EmptyState icon="users" title="Ninguém na equipe ainda" description="Convide quem vai atender as conversas com você." />
    </Card>
  );

  const teamsPanel = (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <TeamDialog
          trigger={<Button variant="primary">Nova equipe</Button>}
          nextPriority={nextPriority}
          members={members}
          channels={channels}
          agents={agents}
        />
      </div>
      {teams.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))]">
          {teams.map((team) => (
            <Card key={team.id} className="flex flex-col gap-3.5 p-5 max-sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className={cn("size-4 rounded-[5px]", teamColorClass[team.color])} aria-hidden="true" />
                  <h2 className="text-lg font-bold">{team.name}</h2>
                </div>
                <Chip>Prioridade {team.priority}</Chip>
              </div>
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))]">
                <div>
                  <h3 className="mb-1.5 text-[13px] font-bold">Horário</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
                    {summarizeBusinessHours(team.businessHours).map((row) => (
                      <div key={row.label} className="contents">
                        <dt className="text-ink-2">{row.label}</dt>
                        <dd>{row.text}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div className="text-[13px] text-ink-2">
                  <h3 className="mb-1.5 font-bold text-ink">Vinculado</h3>
                  <p>Pessoas: {team.memberIds.map(firstName).filter(Boolean).join(", ") || "nenhuma"}</p>
                  <p>Canais: {names(channels, team.channelIds)}</p>
                  <p>Agente: {names(agents, team.agentId ? [team.agentId] : [])}</p>
                </div>
              </div>
              <TeamDialog
                trigger={
                  <Button size="sm" className="self-start" aria-label={`Editar equipe ${team.name}`}>
                    Editar equipe
                  </Button>
                }
                team={team}
                nextPriority={nextPriority}
                members={members}
                channels={channels}
                agents={agents}
              />
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon="users"
            title="Nenhuma equipe ainda"
            description="Equipes dividem as conversas por assunto (ex.: Recepção, Vendas), cada uma com horário e agente próprios."
          />
        </Card>
      )}
    </div>
  );

  return (
    <Page className="gap-[18px]">
      <PageHeader
        title="Equipe"
        description="Quem atende e como as conversas são divididas."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={limitReached ? "err" : userLimit.max !== null && userLimit.used >= userLimit.max - 1 ? "warn" : "neutral"}>
              {userLimit.max === null ? `${userLimit.used} usuários` : `${userLimit.used} de ${userLimit.max} usuários do plano`}
            </Chip>
            {limitReached ? (
              <Button variant="primary" disabled aria-describedby="convite-limite">
                Convidar pessoa
              </Button>
            ) : (
              <MemberDialog trigger={<Button variant="primary">Convidar pessoa</Button>} actorRole={actor.role} teams={teamOptions} />
            )}
          </div>
        }
      />
      {limitReached ? (
        <p id="convite-limite" className="-mt-2 text-[13px] text-ink-2">
          Você usou todos os usuários do plano. Inative alguém
          {can(session.user.role, "billing.manage") ? " ou mude de plano em Ajustes › Plano e cobrança" : " ou peça ao proprietário para mudar de plano"}.
        </p>
      ) : null}
      <TeamTabs people={people} teams={teamsPanel} />
    </Page>
  );
}
