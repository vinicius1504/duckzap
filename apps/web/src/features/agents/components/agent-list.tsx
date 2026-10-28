import type { Agent } from "@duckzap/contracts/agents";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { agentStatusView, jobView } from "../labels";

/** Cartões da tela /agentes. */
export function AgentCards({ agents }: { agents: Agent[] }) {
  return (
    <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr))]">
      {agents.map((a) => (
        <li key={a.id}>
          <Card className="h-full">
            <Link href={`/agentes/${a.id}`} className="flex h-full flex-col gap-2.5 rounded-card p-4 hover:bg-surface-hover">
              <span className="flex items-start justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-rail text-duck" aria-hidden="true">
                    <Icon name={a.job === "instagram_dm" || a.job === "comments" ? "instagram" : "bot"} size={20} />
                  </span>
                  <strong className="truncate">{a.config.name}</strong>
                </span>
                <Chip tone={agentStatusView[a.status].tone}>{agentStatusView[a.status].label}</Chip>
              </span>
              <span className="text-[13px] text-ink-2">{a.config.profile.description || jobView[a.job].description}</span>
              <span className="mt-auto flex flex-wrap items-center gap-1.5">
                <Chip>{jobView[a.job].label}</Chip>
                {a.isDefault ? <Chip tone="info">Padrão</Chip> : null}
                {a.channels.map((c) => (
                  <Chip key={c.id}>{c.name}</Chip>
                ))}
              </span>
              {a.status === "active" ? (
                <span className="text-xs text-ink-2">
                  {a.stats.conversationsLast7d} conversas em 7 dias · {a.stats.handoffRatePercent}% passaram para a equipe
                </span>
              ) : a.pausedReason === "plan_feature" ? (
                <span className="text-xs font-semibold text-warn">Pausado: Instagram faz parte dos planos Pro e Empresarial</span>
              ) : null}
            </Link>
          </Card>
        </li>
      ))}
    </ul>
  );
}
