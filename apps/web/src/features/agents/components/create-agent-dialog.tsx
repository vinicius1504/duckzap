"use client";

import { INSTAGRAM_JOBS, agentJobSchema, type AgentChannel, type AgentJob } from "@duckzap/contracts/agents";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox, Radio } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createAgentAction } from "../actions";
import { jobView } from "../labels";

export function CreateAgentDialog({
  channels,
  instagramAvailable,
  limitReached,
}: {
  channels: AgentChannel[];
  instagramAvailable: boolean;
  /** Plano no limite de agentes. */
  limitReached: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [job, setJob] = useState<AgentJob>("support");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const instagramJob = INSTAGRAM_JOBS.includes(job);
  const visibleChannels = channels.filter((c) => (instagramJob ? c.kind === "instagram" : c.kind !== "instagram"));

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createAgentAction({ name, job, channelIds: channelIds.filter((id) => visibleChannels.some((c) => c.id === id)) });
      if (result.error !== undefined) setError(result.error);
      else {
        setOpen(false);
        router.push(`/agentes/${result.data.id}?aba=simples`);
      }
    });
  }

  if (limitReached) {
    return (
      <Button variant="primary" disabled title="Seu plano está no limite de agentes">
        <Icon name="plus" size={18} /> Novo agente
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className={buttonVariants({ variant: "primary" })}>
        <Icon name="plus" size={18} /> Novo agente
      </DialogTrigger>
      <DialogContent title="Novo agente" description="Escolha o trabalho dele. Em seguida você conta sobre a empresa e a IA monta o perfil para você testar.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div>
            <Label htmlFor="agent-name">Nome do agente</Label>
            <Input id="agent-name" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} placeholder="Ex.: Agente de retorno" />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-[13px] font-semibold">Trabalho</legend>
            {agentJobSchema.options.filter((j) => j !== "scheduling").map((j) => {
              const locked = INSTAGRAM_JOBS.includes(j) && !instagramAvailable;
              return (
                <label
                  key={j}
                  className={cn(
                    "flex min-h-11 items-start gap-3 rounded-control border border-line p-3",
                    job === j && "border-ink ring-1 ring-ink",
                    locked && "opacity-60",
                  )}
                >
                  <Radio name="job" checked={job === j} disabled={locked} onChange={() => setJob(j)} className="mt-0.5" />
                  <span className="flex-1">
                    <strong className="block">{jobView[j].label}</strong>
                    <span className="text-[13px] text-ink-2">{locked ? "Disponível nos planos Pro e Empresarial" : jobView[j].description}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {visibleChannels.length ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1.5 text-[13px] font-semibold">Canais (opcional)</legend>
              {visibleChannels.map((c) => (
                <label key={c.id} className="flex min-h-11 items-center gap-2.5">
                  <Checkbox
                    checked={channelIds.includes(c.id)}
                    onChange={(e) => setChannelIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id)))}
                  />
                  {c.name}
                </label>
              ))}
              <p className="text-xs text-ink-2">O agente começa inativo. Ative depois de testar no simulador.</p>
            </fieldset>
          ) : null}
          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose className={buttonVariants()}>Cancelar</DialogClose>
            <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
              {pending ? <Spinner size={16} /> : null} Criar agente
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
