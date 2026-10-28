import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Tabela dentro de card com rolagem horizontal própria (a página nunca rola de lado). */
export function Table({
  className,
  minWidth = 820,
  ...props
}: HTMLAttributes<HTMLTableElement> & { minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className={cn("w-full border-collapse", className)} style={{ minWidth }} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn("border-b border-line bg-bg px-3 py-2.5 text-left text-xs font-bold text-ink-2", className)}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("border-b border-line px-3 py-3 align-middle", className)} {...props} />;
}
