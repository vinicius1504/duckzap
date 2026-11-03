import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/** Contêiner padrão de página dentro do shell. */
export function Page({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main className={cn("flex flex-col gap-6 px-8 pb-10 pt-7 max-md:px-4 max-md:pt-5", className)} {...props} />;
}

/** Estilo único do título de página (h1). Use `PageHeader`; esta constante existe para quem precisa do h1 fora dele (telas de auth). */
export const pageTitleClass = "text-[28px] font-extrabold tracking-[-0.02em] break-words max-md:text-2xl";

export function PageHeader({
  title,
  description,
  actions,
  badges,
  align = "end",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Chips de status ao lado do título (ex.: situação da campanha). */
  badges?: ReactNode;
  /** `end` (padrão): ações alinhadas à base do título. `start`: ao topo, quando há descrição longa ou chips. */
  align?: "end" | "start";
}) {
  const heading = <h1 className={pageTitleClass}>{title}</h1>;
  return (
    <div className={cn("flex flex-wrap justify-between gap-4", align === "end" ? "items-end" : "items-start")}>
      <div className="min-w-0">
        {badges ? (
          <div className="flex flex-wrap items-center gap-3">
            {heading}
            {badges}
          </div>
        ) : (
          heading
        )}
        {description ? <p className="mt-1 text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** Passos numerados de assistentes (campanha, novo canal, onboarding). */
export function Steps({ steps, current, label }: { steps: readonly string[]; current: number; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap gap-x-[22px] gap-y-2.5">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "on" : "todo";
        return (
          <li
            key={step}
            aria-current={state === "on" ? "step" : undefined}
            className={cn("flex items-center gap-2 font-semibold text-ink-2", state !== "todo" && "text-ink")}
          >
            <b
              className={cn(
                "flex size-7 items-center justify-center rounded-full bg-surface-2 text-[13px]",
                state === "on" && "bg-duck text-on-duck",
                state === "done" && "bg-ink text-bg",
              )}
            >
              {index + 1}
            </b>
            {step}
          </li>
        );
      })}
    </ol>
  );
}
