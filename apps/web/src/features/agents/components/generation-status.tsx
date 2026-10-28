"use client";

import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { GEN_IDS, type GenerationApi } from "../use-generation";
import { GeneratorProgress, useElapsedSeconds } from "./generator-progress";

/** Segundos que faltam do tempo de espera pedido pela API (429). 0 = pode tentar. */
export function useCooldownLeft(cooldown: GenerationApi["cooldown"]): number {
  const elapsed = useElapsedSeconds(cooldown !== null, cooldown?.startedAt ?? null);
  return cooldown ? Math.max(0, Math.ceil(cooldown.seconds - elapsed)) : 0;
}

/**
 * Faixa de estado da geração, em cima das abas (vale em qualquer aba): ou o progresso (com Cancelar) ou o erro (com a ação
 * que faz sentido: tentar de novo ou ver planos). O foco vai para cá quando um dos dois aparece.
 */
export function GenerationStatus({ generation }: { generation: GenerationApi }) {
  const { generating, failure, cooldown } = generation;
  const cooldownLeft = useCooldownLeft(cooldown);

  if (generating) return <GeneratorProgress startedAt={generation.startedAt} onCancel={generation.cancel} cancelling={generation.cancelling} />;
  if (!failure) return null;

  const hasFieldMarks = Boolean(failure.fields && Object.keys(failure.fields).length > 0);
  return (
    <div id={GEN_IDS.failure} tabIndex={-1} className="outline-none">
      <Alert
        tone={failure.code === "budget_exceeded" ? "warn" : "err"}
        live
        action={
          failure.code === "budget_exceeded" ? (
            <Link href="/ajustes?aba=plano" className={buttonVariants({ size: "sm", className: "max-md:h-11" })}>
              Ver planos
            </Link>
          ) : failure.retryable && !hasFieldMarks ? (
            <Button size="sm" className="max-md:h-11" disabled={cooldownLeft > 0} onClick={generation.generate}>
              <Icon name="refresh" size={14} /> {cooldownLeft > 0 ? `Tentar de novo em ${cooldownLeft} s` : "Tentar de novo"}
            </Button>
          ) : null
        }
      >
        {failure.message}
      </Alert>
    </div>
  );
}
