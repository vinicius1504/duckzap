"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Card } from "./card";
import { Icon, type IconName } from "./icon";

/**
 * Cartão que abre e fecha (mesmo desenho do "Follow-up automático" dos agentes): cabeçalho com ícone, título e um resumo
 * do que está dentro, seta à direita. O conteúdo só existe aberto; o estado de quem edita deve morar no pai, para não
 * se perder ao fechar. `onOpenChange` avisa o pai (por exemplo, para guardar a escolha).
 */
export function CollapsibleCard({
  title,
  summary,
  icon,
  defaultOpen = false,
  className,
  children,
}: {
  title: ReactNode;
  /** Linha pequena sob o título (o estado atual em poucas palavras). */
  summary?: ReactNode;
  icon: IconName;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <Card className={cn("flex flex-col", className)}>
      <h2 className="p-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-h-11 w-full items-center gap-3 rounded-control text-left hover:bg-surface-hover"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-2">
            <Icon name={icon} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-bold">{title}</span>
            {summary ? <span className="block text-[13px] font-normal text-ink-2">{summary}</span> : null}
          </span>
          <Icon name="chevronDown" size={18} className={cn("shrink-0", open && "rotate-180")} />
        </button>
      </h2>
      {open ? (
        <div id={bodyId} className="border-t border-line p-[18px]">
          {children}
        </div>
      ) : null}
    </Card>
  );
}
