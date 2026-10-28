"use client";

import type { Agent } from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { agentStatusView, jobView } from "../labels";

/**
 * Cabeçalho da página do agente: nome, situação, canais e equipes (na mesma linha do título), Ativar/Pausar (com o motivo quando bloqueado), Salvar com o
 * aviso de alterações não salvas e o acesso ao histórico de versões.
 */
export function AgentHeader({
  agent,
  name,
  dirty,
  busy,
  activationBlocked,
  onSave,
  onSaveAndActivate,
  onPause,
  onDiscard,
  onOpenHistory,
}: {
  agent: Agent;
  /** Nome em edição (muda ao digitar, antes de salvar). */
  name: string;
  dirty: boolean;
  /** Salvando, ativando ou gerando: ações desabilitadas. */
  busy: boolean;
  activationBlocked: string | null;
  onSave: () => void;
  onSaveAndActivate: () => void;
  onPause: () => void;
  onDiscard: () => void;
  onOpenHistory: () => void;
}) {
  const status = agentStatusView[agent.status];
  const active = agent.status === "active";
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 break-words text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">{name.trim() || agent.config.name}</h1>
        <Chip tone={status.tone}>{status.label}</Chip>
        <Chip>{jobView[agent.job].label}</Chip>
        {agent.isDefault ? <Chip tone="info">Padrão</Chip> : null}
        {agent.channels.length > 0 ? (
          <span role="group" aria-label="Canais ligados" className="flex flex-wrap items-center gap-1.5">
            {agent.channels.map((c) => (
              <Chip key={c.id} tone="info">
                {c.name}
              </Chip>
            ))}
          </span>
        ) : null}
        {agent.teams.length > 0 ? (
          <span role="group" aria-label="Equipes" className="flex flex-wrap items-center gap-1.5">
            {agent.teams.map((team) => (
              <Chip key={team}>Equipe {team}</Chip>
            ))}
          </span>
        ) : null}
        <Link href="/canais" className="text-xs font-semibold text-ink-2 underline underline-offset-2 hover:text-ink max-md:py-2">
          {agent.channels.length > 0 ? "Mudar em Canais" : "Ligar a um canal em Canais"}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <Button className="max-md:h-11" disabled={busy} onClick={onPause}>
            <Icon name="pause" size={16} /> Pausar
          </Button>
        ) : (
          <Button className="max-md:h-11" disabled={busy || Boolean(activationBlocked)} aria-describedby={activationBlocked ? "ag-activate-reason" : undefined} onClick={onSaveAndActivate}>
            <Icon name="play" size={16} /> {dirty ? "Salvar e ativar" : "Ativar agente"}
          </Button>
        )}
        <Button className="max-md:h-11" onClick={onOpenHistory}>
          <Icon name="history" size={16} /> Histórico de versões
        </Button>
        <span className="flex-1" />
        <span className="text-[13px] text-ink-2" aria-live="polite">
          {dirty ? "Alterações não salvas" : `Versão ${agent.currentVersion} em uso`}
        </span>
        {dirty ? (
          <Button variant="ghost" className="max-md:h-11" disabled={busy} onClick={onDiscard}>
            Descartar
          </Button>
        ) : null}
        <Button variant="primary" className="max-md:h-11" disabled={!dirty || busy} onClick={onSave}>
          {busy ? <Spinner size={16} /> : null} Salvar
        </Button>
      </div>
      {!active && activationBlocked ? (
        <p id="ag-activate-reason" className="text-[13px] font-semibold text-warn">
          Não dá para ativar ainda: {activationBlocked}
        </p>
      ) : null}
    </header>
  );
}
