"use client";

import { Button } from "@duckzap/ui/components/button";
import { Spinner } from "@duckzap/ui/components/feedback";
import { useEffect, useState } from "react";
import { formatElapsed, phaseAt } from "@/lib/agent-generator";
import { GEN_IDS } from "../use-generation";

/** Segundos desde `startedAt` enquanto `active`. Usa o relógio (não conta ticks): aba em segundo plano não atrasa o número. */
export function useElapsedSeconds(active: boolean, startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active && startedAt !== null ? Math.max(0, (now - startedAt) / 1000) : 0;
}

/**
 * Painel de progresso da geração. Sem porcentagem (a API não informa o andamento): o texto muda conforme o tempo e há uma
 * barra "indeterminada". O cronômetro é só visual (`aria-hidden`); a região `role="status"` muda umas 5 vezes durante a
 * espera, nunca a cada segundo. O foco vem para cá quando a geração começa; o botão Cancelar fica logo depois.
 * Mora em cima das abas: continua visível se o dono trocar de aba enquanto espera.
 */
export function GeneratorProgress({ startedAt, onCancel, cancelling }: { startedAt: number | null; onCancel: () => void; cancelling: boolean }) {
  const elapsed = useElapsedSeconds(true, startedAt);
  const phase = phaseAt(elapsed);
  return (
    <div
      id={GEN_IDS.progress}
      tabIndex={-1}
      aria-busy="true"
      aria-label="Gerando o perfil com IA"
      className="flex flex-col gap-3 rounded-control bg-surface-2 p-4 motion-reduce:[&_svg]:animate-none"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Spinner size={20} />
        <p role="status" className="min-w-0 flex-[1_1_220px] font-semibold">
          {phase.label}
        </p>
        <span aria-hidden="true" className="text-[13px] tabular-nums text-ink-2">
          {formatElapsed(elapsed)}
        </span>
      </div>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full w-full animate-pulse rounded-full bg-duck motion-reduce:animate-none" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-[1_1_240px] text-[13px] text-ink-2">
          Costuma levar de 20 a 30 segundos, mas pode levar até 2 minutos. Nada é salvo no agente e o que você escreveu fica guardado.
        </p>
        <Button onClick={onCancel} disabled={cancelling} className="max-md:h-11">
          {cancelling ? "Cancelando…" : "Cancelar"}
        </Button>
      </div>
    </div>
  );
}
