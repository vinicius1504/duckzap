import { Radio } from "@duckzap/ui/components/form-controls";
import { cn } from "@duckzap/ui/cn";
import type { ReactNode } from "react";

/** Opção de rádio em formato de cartão (público, canal, modelo). */
export function OptionCard({
  name,
  value,
  checked,
  disabled,
  onSelect,
  children,
  aside,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-control border border-line bg-surface p-3.5 hover:bg-surface-hover",
        checked && "border-ink ring-1 ring-ink",
        disabled && "cursor-not-allowed opacity-60 hover:bg-surface",
      )}
    >
      <Radio name={name} value={value} checked={checked} disabled={disabled} onChange={onSelect} className="mt-0.5" />
      <span className="min-w-0 flex-1">{children}</span>
      {aside}
    </label>
  );
}
