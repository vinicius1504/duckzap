import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const chipVariants = cva(
  "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-ink-2",
        ok: "bg-ok-bg text-ok",
        warn: "bg-warn-bg text-warn",
        err: "bg-err-bg text-err",
        info: "bg-info-bg text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type ChipTone = NonNullable<VariantProps<typeof chipVariants>["tone"]>;

export function Chip({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof chipVariants>) {
  return <span className={cn(chipVariants({ tone }), className)} {...props} />;
}
