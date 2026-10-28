import { cn } from "@duckzap/ui/cn";
import { formatCount } from "@/lib/agent-generator";

/** "123 / 200". Fica vermelho acima do limite. Ligue ao campo com `aria-describedby={id}`. */
export function CharCounter({ id, length, max, className }: { id: string; length: number; max: number; className?: string }) {
  const over = length > max;
  return (
    <span id={id} className={cn("shrink-0 text-xs tabular-nums", over ? "font-semibold text-err" : "text-ink-2", className)}>
      {formatCount(length)} / {formatCount(max)}
      {over ? " (acima do limite)" : ""}
    </span>
  );
}
