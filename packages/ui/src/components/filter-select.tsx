import type { SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Filtro de barra (padrão de todas as listas): o nome do filtro fica sempre visível dentro do campo ("Canal | Todos") e
 * o valor escolhido aparece ao lado. Mesma altura em todas as telas. Dentro de gaveta/diálogo use `Label` + `Select`.
 * O <label> envolve o <select>, então clicar no nome abre a lista e leitores de tela leem "Canal, Todos".
 */
export function FilterSelect({
  id,
  label,
  className,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & { id: string; label: string }) {
  return (
    <label
      htmlFor={id}
      className={cn("inline-flex h-10 min-w-0 items-center gap-1.5 rounded-control border border-field bg-surface pl-3 text-[13px] max-md:h-11", className)}
    >
      <span className="shrink-0 font-semibold text-ink-2">{label}</span>
      <select id={id} className="h-full min-w-0 flex-1 cursor-pointer border-0 bg-transparent pl-1 pr-2 font-semibold text-ink" {...props}>
        {children}
      </select>
    </label>
  );
}
