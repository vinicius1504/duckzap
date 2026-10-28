"use client";

import type { ConversationMode, FollowUp } from "@duckzap/contracts/conversations";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Icon, type IconName } from "@duckzap/ui/components/icon";
import { useOptimistic, useState, useTransition } from "react";
import { cancelFollowUpAction, scheduleFollowUpAction, setConversationModeAction, setFollowUpPausedAction } from "../actions";
import { addDays, dateInZone, followUpLabel, MODE_OPTIONS, modeHint, NO_PERMISSION_HINT, zonedIso } from "./view-model";

const MODE_ICON: Record<ConversationMode, IconName> = { ai: "bot", copilot: "sparkle", human: "user" };

type Props = {
  conversationId: string;
  mode: ConversationMode;
  agentName: string;
  followUp: FollowUp | null;
  followUpAgentName: string | null;
  canChangeMode: boolean;
  canFollowUp: boolean;
  resolved: boolean;
  nowIso: string;
  timeZone: string;
};

/** Controles do cabeçalho da conversa: modo (quem responde) e follow-up. Ficam ao lado do menu "Mais ações". */
export function ModeControls(props: Props) {
  const { conversationId, agentName, canChangeMode, resolved } = props;
  const [, startTransition] = useTransition();
  const [mode, setOptimisticMode] = useOptimistic(props.mode);
  const [error, setError] = useState<string | null>(null);
  const label = MODE_OPTIONS.find((o) => o.value === mode)?.label;

  function changeMode(next: ConversationMode) {
    if (!canChangeMode || next === mode) return;
    setError(null);
    startTransition(async () => {
      setOptimisticMode(next);
      const result = await setConversationModeAction(conversationId, next);
      if (result) setError(result.error);
    });
  }

  return (
    <>
      {canChangeMode && !resolved ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" aria-label={`Modo da conversa: ${label}. Alterar`} title={modeHint(mode, agentName)}>
              <Icon name={MODE_ICON[mode]} size={16} />
              {label}
              <Icon name="chevronDown" size={14} strokeWidth={2.4} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[min(340px,calc(100vw-24px))]">
            <DropdownMenuLabel>Quem responde esta conversa</DropdownMenuLabel>
            {MODE_OPTIONS.map((o) => (
              <DropdownMenuItem key={o.value} onSelect={() => changeMode(o.value)} className="items-start py-2">
                <Icon name={MODE_ICON[o.value]} size={18} className="mt-0.5 shrink-0" />
                <span className="flex flex-1 flex-col">
                  <span className="font-semibold">{o.label}</span>
                  <span className="text-[13px] font-normal text-ink-2">{modeHint(o.value, agentName)}</span>
                </span>
                {o.value === mode ? <Icon name="check" size={16} strokeWidth={2.4} className="mt-0.5 shrink-0" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Chip title={canChangeMode ? modeHint(mode, agentName) : `${modeHint(mode, agentName)} ${NO_PERMISSION_HINT}`}>Modo: {label}</Chip>
      )}
      {!resolved ? <FollowUpControl {...props} /> : null}
      {error ? (
        <span role="alert" className="w-full text-right text-[13px] font-semibold text-err">
          {error}
        </span>
      ) : null}
    </>
  );
}

function FollowUpControl({ conversationId, followUp, followUpAgentName, canFollowUp, nowIso, timeZone }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ error: string } | null>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result) setError(result.error);
    });
  }

  const today = dateInZone(nowIso, timeZone);
  const presets = [
    { label: "Em 2 horas", at: new Date(new Date(nowIso).getTime() + 2 * 3_600_000).toISOString() },
    { label: "Amanhã às 9h", at: zonedIso(addDays(today, 1), "09:00", timeZone) },
    { label: "Em 3 dias às 9h", at: zonedIso(addDays(today, 3), "09:00", timeZone) },
  ];

  const schedule = (at: string) => run(() => scheduleFollowUpAction(conversationId, at));
  const errorLine = error ? (
    <span role="alert" className="w-full text-right text-[13px] font-semibold text-err">
      {error}
    </span>
  ) : null;

  if (!followUp) {
    return (
      <>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={!canFollowUp || pending} title={canFollowUp ? undefined : NO_PERMISSION_HINT}>
              <Icon name="clock" size={16} />
              Agendar follow-up
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Lembrar o cliente se ele não responder</DropdownMenuLabel>
            {presets.map((p) => (
              <DropdownMenuItem key={p.label} onSelect={() => schedule(p.at)}>
                {p.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {errorLine}
      </>
    );
  }

  // com follow-up marcado, um só botão com o horário abre pausar/retomar, reagendar e cancelar
  const when = followUpLabel(followUp.scheduledAt, nowIso, timeZone);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            disabled={!canFollowUp || pending}
            title={followUpAgentName ? `Enviado por ${followUpAgentName}` : undefined}
            aria-label={`${followUp.paused ? "Follow-up pausado" : "Follow-up"} ${when}. Opções`}
          >
            <Icon name={followUp.paused ? "pause" : "clock"} size={16} />
            {followUp.paused ? `Follow-up pausado · ${when}` : `Follow-up ${when}`}
            <Icon name="chevronDown" size={14} strokeWidth={2.4} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => run(() => setFollowUpPausedAction(conversationId, !followUp.paused))}>
            <Icon name={followUp.paused ? "play" : "pause"} size={16} />
            {followUp.paused ? "Retomar follow-up" : "Pausar follow-up"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Reagendar</DropdownMenuLabel>
          {presets.map((p) => (
            <DropdownMenuItem key={p.label} onSelect={() => schedule(p.at)}>
              {p.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger" onSelect={() => run(() => cancelFollowUpAction(conversationId))}>
            <Icon name="close" size={16} />
            Cancelar follow-up
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {errorLine}
    </>
  );
}
