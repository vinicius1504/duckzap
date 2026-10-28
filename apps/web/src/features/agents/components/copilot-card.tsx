"use client";

import type { CopilotOverview } from "@duckzap/contracts/agents";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Switch } from "@duckzap/ui/components/switch";
import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { formatDate } from "@/lib/format";
import { setCopilotEnabledAction } from "../actions";

/** Copiloto: sugestões para a equipe, com feedback útil/ruim. Recurso do plano Empresarial (§1.2). */
export function CopilotCard({ copilot, available, timeZone }: { copilot: CopilotOverview; available: boolean; timeZone: string }) {
  const [enabled, setEnabled] = useOptimistic(copilot.enabled);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (!available) {
    return (
      <Card className="flex flex-col gap-2.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <strong>Copiloto</strong>
          <Chip>Plano Empresarial</Chip>
        </div>
        <p className="text-[13px] text-ink-2">
          Sugere respostas para a equipe no compositor das Conversas. Nada é enviado sozinho: a pessoa revisa, envia e marca se a
          sugestão foi útil.
        </p>
        <Link href="/ajustes?aba=plano" className={buttonVariants({ size: "sm", className: "self-start" })}>
          Conhecer o plano Empresarial
        </Link>
      </Card>
    );
  }

  const total = copilot.feedback.useful + copilot.feedback.bad;
  const usefulPct = total ? Math.round((copilot.feedback.useful / total) * 100) : 0;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="copilot-switch" className="font-bold">
          Copiloto
        </label>
        <Switch
          id="copilot-switch"
          checked={enabled}
          onCheckedChange={(value) =>
            startTransition(async () => {
              setEnabled(value);
              const result = await setCopilotEnabledAction(value);
              setError(result.error ?? null);
            })
          }
        />
      </div>
      <p className="text-[13px] text-ink-2">Sugere respostas para a equipe {copilot.teams.length ? `nas equipes ${copilot.teams.join(" e ")}` : ""}.</p>
      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}
      <div>
        <p className="text-[13px]">
          Feedback recebido: <strong>{copilot.feedback.useful}</strong> úteis · <strong>{copilot.feedback.bad}</strong> ruins
        </p>
        <div className="mt-1.5 flex h-2.5 overflow-hidden rounded-md bg-surface-2" aria-hidden="true">
          <span className="bg-ok" style={{ width: `${usefulPct}%` }} />
          <span className="bg-err" style={{ width: `${100 - usefulPct}%` }} />
        </div>
        <p className="mt-1 text-xs text-ink-2">{usefulPct}% das sugestões avaliadas foram úteis</p>
      </div>
      {copilot.recentBad.length ? (
        <details className="text-[13px]">
          <summary className="min-h-11 cursor-pointer py-2 font-semibold">Sugestões marcadas como ruins</summary>
          <ul className="flex flex-col gap-2">
            {copilot.recentBad.map((b) => (
              <li key={b.id} className="rounded-control bg-surface-2 p-2.5">
                <p className="flex items-start gap-1.5">
                  <Icon name="thumbDown" size={14} className="mt-0.5 shrink-0 text-err" />“{b.suggestion}”
                </p>
                <p className="mt-1 text-xs text-ink-2">
                  {b.reason ?? "Sem motivo"} ·{" "}
                  {formatDate(b.at, { day: "2-digit", month: "2-digit" }, timeZone)}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-2">Esses casos viram testes para melhorar o agente.</p>
        </details>
      ) : null}
    </Card>
  );
}
