"use client";

import type { Agent, AgentVersion } from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogContent } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { useState, useTransition } from "react";
import { formatDate } from "@/lib/format";
import { rollbackAgentVersionAction, setAgentStatusAction } from "../actions";

/**
 * Gaveta "Histórico de versões": a lista de versões com "Voltar a esta versão" (a confirmação aparece dentro da própria
 * gaveta) e, no fim, "Desativar agente". Ativar e pausar ficam no cabeçalho da página.
 */
export function VersionsDrawer({
  open,
  onOpenChange,
  agent,
  versions,
  timeZone,
  dirty,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  versions: AgentVersion[];
  timeZone: string;
  dirty: boolean;
}) {
  const [target, setTarget] = useState<AgentVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const previous = versions.find((v) => v.number < agent.currentVersion);
  const when = (iso: string) => formatDate(iso, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }, timeZone);

  function rollback(version: AgentVersion) {
    setError(null);
    startTransition(async () => {
      const result = await rollbackAgentVersionAction(agent.id, version.id);
      if (result.error !== undefined) setError(result.error);
      else {
        setTarget(null);
        onOpenChange(false);
      }
    });
  }

  function deactivate() {
    setError(null);
    startTransition(async () => {
      const result = await setAgentStatusAction(agent.id, "inactive");
      if (result.error !== undefined) setError(result.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTarget(null);
        onOpenChange(next);
      }}
    >
      <DialogContent side="right" title="Histórico de versões" description="Cada vez que você salva, uma versão nova é criada. Nada do histórico é apagado.">
        {previous ? (
          <Button size="sm" className="self-start" onClick={() => setTarget(previous)} disabled={pending}>
            <Icon name="history" size={16} /> Voltar à versão anterior
          </Button>
        ) : null}

        {target ? (
          <div role="group" aria-labelledby="ver-confirm-title" className="flex flex-col gap-2 rounded-control border border-warn bg-warn-bg p-3.5">
            <h3 id="ver-confirm-title" className="font-bold text-warn">
              Voltar à versão {target.number}?
            </h3>
            <p className="text-[13px]">
              Uma versão nova é criada com a configuração antiga. “{target.summary}” · {when(target.createdAt)}
            </p>
            {dirty ? <Alert tone="warn">Suas alterações não salvas serão descartadas.</Alert> : null}
            <div className="flex flex-wrap gap-2">
              <Button className="max-md:h-11" onClick={() => setTarget(null)} disabled={pending}>
                Cancelar
              </Button>
              <Button variant="primary" className="max-md:h-11" disabled={pending} onClick={() => rollback(target)}>
                {pending ? <Spinner size={16} /> : null} Voltar a esta versão
              </Button>
            </div>
          </div>
        ) : null}

        <ol className="flex flex-col divide-y divide-line rounded-control border border-line">
          {versions.map((v) => {
            const current = v.number === agent.currentVersion;
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
                <span className="w-10 font-bold tabular-nums">v{v.number}</span>
                <span className="min-w-0 flex-[1_1_160px]">
                  <span className="block">{v.summary}</span>
                  <span className="text-xs text-ink-2">
                    {v.createdBy} · {when(v.createdAt)}
                  </span>
                </span>
                {current ? (
                  <Chip tone="ok">Em uso</Chip>
                ) : (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setTarget(v)} className="max-md:h-11" aria-label={`Restaurar a versão ${v.number}`}>
                    Restaurar
                  </Button>
                )}
              </li>
            );
          })}
        </ol>

        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}

        {agent.status !== "inactive" ? (
          <section aria-labelledby="ver-status" className="flex flex-col gap-2 rounded-control border border-line p-3.5">
            <h3 id="ver-status" className="font-bold">
              Desativar o agente
            </h3>
            <p className="text-xs text-ink-2">Pausado ou inativo, as conversas dos canais dele vão direto para a equipe. Para só pausar, use o botão no topo da página.</p>
            <Button variant="ghost" className="self-start text-err max-md:h-11" disabled={pending} onClick={deactivate}>
              Desativar agente
            </Button>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
