import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Espaçamento interno padrão: `sm` 16 px, `md` 20 px (o mais usado), `lg` 24 px (formulários e painéis; 16 px no celular). */
const cardPadding = {
  sm: "p-4",
  md: "p-5",
  lg: "p-6 max-sm:p-4",
} as const;

export function Card({ className, padding, ...props }: HTMLAttributes<HTMLElement> & { padding?: keyof typeof cardPadding }) {
  return <section className={cn("rounded-card border border-line bg-surface", padding && cardPadding[padding], className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-base font-bold", className)} {...props} />;
}
