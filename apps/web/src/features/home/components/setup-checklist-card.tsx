"use client";

import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Card, CardTitle } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Progress } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useId, useSyncExternalStore } from "react";
import { requestTour } from "@/features/tour/components/product-tour";
import { TOUR_ANCHORS } from "@/features/tour/steps";
import { canDismissChecklist, setupKindLabel, shouldShowChecklist, type SetupChecklist } from "../setup-checklist";

// "Esconder" vale por navegador (localStorage), como as preferências de som e de notificação: não há preferência
// guardada no servidor para isso. Só aparece depois que os itens obrigatórios estão feitos.
const CHANGE_EVENT = "duckchat:setup-dismissed-change";
const keyFor = (organizationId: string) => `duckchat:setup-dismissed:${organizationId}`;

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function SetupChecklistCard({ list, organizationId }: { list: SetupChecklist; organizationId: string }) {
  const key = keyFor(organizationId);
  const titleId = useId();
  // no servidor conta como "escondido": quem já dispensou não vê o cartão piscar; quem não dispensou o vê ao carregar
  const dismissed = useSyncExternalStore(subscribe, () => readDismissed(key), () => true);
  if (!shouldShowChecklist(list, dismissed)) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // modo privado: some só até recarregar
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  const pending = list.total - list.doneCount;

  return (
    <Card padding="md" aria-labelledby={titleId} data-tour={TOUR_ANCHORS.checklist}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle id={titleId}>Primeiros passos</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-2">
            {list.doneCount} de {list.total} feitos
          </span>
          <Button size="sm" variant="ghost" onClick={requestTour}>
            <Icon name="help" size={16} />
            Fazer o tour
          </Button>
        </div>
      </div>
      <p className="mb-3.5 mt-0.5 text-ink-2">
        {list.requiredDone
          ? "O essencial está pronto. Veja o que ainda pode melhorar o atendimento."
          : "O que falta para o seu atendimento funcionar bem."}
      </p>
      <Progress value={list.percent} label="Configuração concluída (%)" tone="duck" />

      <ol className="mt-2">
        {list.items.map((item) => {
          const tag = setupKindLabel[item.kind];
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line py-3 first:border-t-0">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full",
                  item.done ? "bg-ok-bg text-ok" : "border-2 border-line text-ink-2",
                )}
                aria-hidden="true"
              >
                {item.done ? <Icon name="check" size={16} strokeWidth={2.4} /> : <Icon name={item.icon} size={14} />}
              </span>
              <div className="min-w-0 flex-[1_1_200px]">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="sr-only">{item.done ? "Feito: " : "Pendente: "}</span>
                  <strong className={cn(item.done && "font-semibold text-ink-2 line-through")}>{item.title}</strong>
                  {tag && !item.done ? <Chip tone={item.kind === "recommended" ? "info" : "neutral"}>{tag}</Chip> : null}
                </p>
                {item.done ? null : <p className="text-[13px] text-ink-2">{item.hint}</p>}
              </div>
              {item.done ? null : (
                <Link href={item.href} className={buttonVariants({ size: "sm", variant: item.kind === "required" ? "primary" : "secondary" })}>
                  {item.action}
                  <span className="sr-only">: {item.title}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ol>

      {canDismissChecklist(list) ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-[13px] text-ink-2">
            {pending === 1 ? "Falta 1 item" : `Faltam ${pending} itens`} que não são obrigatórios. Dá para fazer depois.
          </p>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Esconder
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
