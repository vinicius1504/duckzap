"use client";

import type { Member, Team, TeamColor, TeamInput } from "@duckzap/contracts/team";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition, type ReactElement } from "react";
import { BusinessHoursEditor } from "@/features/settings/components/business-hours-editor";
import { defaultBusinessHours } from "@/features/settings/components/business-hours";
import { ConfirmDialog } from "@/features/settings/components/confirm-dialog";
import { deleteTeamAction, saveTeamAction } from "../actions";
import { teamColorClass, teamColors } from "./labels";

type Option = { id: string; name: string };

function initialInput(team: Team | undefined, nextPriority: number): TeamInput {
  if (team) {
    // saudação e fora do horário da equipe saíram da tela (nenhum envio os usa); não são reenviados ao salvar
    const { id: _id, greeting: _greeting, outOfHoursMessage: _outOfHours, ...rest } = team;
    return structuredClone(rest);
  }
  return {
    name: "",
    color: "blue",
    priority: nextPriority,
    businessHours: defaultBusinessHours(),
    memberIds: [],
    channelIds: [],
    agentId: null,
  };
}

function toggle(list: string[], id: string, on: boolean) {
  return on ? [...list, id] : list.filter((x) => x !== id);
}

/** Criar equipe (sem `team`) ou editar (com `team`). */
export function TeamDialog({
  trigger,
  team,
  nextPriority,
  members,
  channels,
  agents,
}: {
  trigger: ReactElement;
  team?: Team;
  nextPriority: number;
  members: Member[];
  channels: Option[];
  agents: Option[];
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState<TeamInput>(() => initialInput(team, nextPriority));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const prefix = team ? `equipe-${team.id}` : "nova-equipe";
  const set = <K extends keyof TeamInput>(key: K, value: TeamInput[K]) => setInput((i) => ({ ...i, [key]: value }));
  const selectable = members.filter((m) => m.status !== "inactive");

  function submit() {
    startTransition(async () => {
      const result = await saveTeamAction(team?.id ?? null, input);
      if (result.ok) setOpen(false);
      else setError(result.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setInput(initialInput(team, nextPriority));
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title={team ? `Editar ${team.name}` : "Nova equipe"} size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-5"
          noValidate
        >
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
            <div>
              <Label htmlFor={`${prefix}-nome`}>Nome</Label>
              <Input id={`${prefix}-nome`} value={input.name} onChange={(e) => set("name", e.target.value)} maxLength={40} required />
            </div>
            <div>
              <Label htmlFor={`${prefix}-prioridade`}>Prioridade</Label>
              <Input
                id={`${prefix}-prioridade`}
                type="number"
                min={1}
                max={20}
                value={input.priority}
                onChange={(e) => set("priority", Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                aria-describedby={`${prefix}-prioridade-dica`}
              />
              <p id={`${prefix}-prioridade-dica`} className="mt-1 text-xs text-ink-2">
                1 recebe primeiro as conversas sem equipe.
              </p>
            </div>
          </div>

          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Cor</legend>
            <div className="flex flex-wrap gap-2">
              {teamColors.map((color) => (
                <label
                  key={color.value}
                  className="flex size-11 cursor-pointer items-center justify-center rounded-control border border-line has-[:checked]:border-ink has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ink"
                >
                  <input
                    type="radio"
                    name={`${prefix}-cor`}
                    value={color.value}
                    checked={input.color === color.value}
                    onChange={() => set("color", color.value satisfies TeamColor)}
                    className="sr-only"
                  />
                  <span className={cn("size-5 rounded-[5px]", teamColorClass[color.value])} aria-hidden="true" />
                  <span className="sr-only">{color.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <p className="mb-1.5 text-[13px] font-semibold">Horário de atendimento</p>
            <BusinessHoursEditor idPrefix={`${prefix}-horario`} value={input.businessHours} onChange={(v) => set("businessHours", v)} />
          </div>

          <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold">Pessoas</legend>
              {selectable.map((m) => (
                <label key={m.id} className="flex min-h-11 items-center gap-2.5">
                  <Checkbox
                    checked={input.memberIds.includes(m.id)}
                    onChange={(e) => set("memberIds", toggle(input.memberIds, m.id, e.target.checked))}
                  />
                  {m.name}
                  {m.status === "invited" ? <span className="text-xs text-ink-2">(convite pendente)</span> : null}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-semibold">Canais</legend>
              {channels.length ? (
                channels.map((c) => (
                  <label key={c.id} className="flex min-h-11 items-center gap-2.5">
                    <Checkbox
                      checked={input.channelIds.includes(c.id)}
                      onChange={(e) => set("channelIds", toggle(input.channelIds, c.id, e.target.checked))}
                    />
                    {c.name}
                  </label>
                ))
              ) : (
                <p className="text-ink-2">Nenhum canal conectado.</p>
              )}
              <p className="mt-1 text-xs text-ink-2">Um canal pertence a uma equipe por vez.</p>
            </fieldset>
            <div>
              <Label htmlFor={`${prefix}-agente`}>Agente de IA</Label>
              <Select
                id={`${prefix}-agente`}
                value={input.agentId ?? ""}
                onChange={(e) => set("agentId", e.target.value || null)}
              >
                <option value="">Sem agente (só pessoas)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}

          <DialogFooter className="justify-between">
            {team ? (
              <ConfirmDialog
                trigger={
                  <Button variant="ghost" className="text-err">
                    Excluir equipe
                  </Button>
                }
                title={`Excluir ${team.name}?`}
                description="As pessoas continuam na empresa e os canais ficam sem equipe até você vincular outra."
                confirmLabel="Excluir"
                danger
                onConfirm={async () => {
                  const result = await deleteTeamAction(team.id);
                  if (result.ok) setOpen(false);
                  return result;
                }}
              />
            ) : (
              <span />
            )}
            <div className="flex flex-wrap gap-2">
              <DialogClose asChild>
                <Button>Cancelar</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Salvando…" : team ? "Salvar" : "Criar equipe"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
