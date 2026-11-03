import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      variant: {
        primary: "border-duck bg-duck text-on-duck hover:border-duck-2 hover:bg-duck-2",
        secondary: "border-line bg-surface text-ink hover:bg-surface-hover",
        ghost: "border-transparent bg-transparent text-ink hover:bg-surface-hover",
        /** Ação destrutiva já confirmada (Excluir, Cancelar envio). Sempre atrás de uma confirmação. */
        danger: "border-err bg-err text-bg hover:opacity-90",
        /** Ação destrutiva leve, em linha de tabela/lista (Desconectar, Remover). */
        "danger-ghost": "border-transparent bg-transparent text-err hover:bg-err-bg",
      },
      size: {
        sm: "h-8 rounded-lg px-3 text-[13px]",
        // alvo de toque de 44 px no celular já vem de fábrica (não repita `max-md:h-11` por cima)
        md: "h-10 px-4 max-md:h-11",
        lg: "h-11 px-[18px] font-bold",
        icon: "size-10 p-0 max-md:size-11",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
