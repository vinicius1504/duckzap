import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * "Voltar" de página de detalhe (padrão único): link de texto acima do título, com o nome da lista de onde a pessoa veio
 * ("Campanhas", "Clientes"). Sempre um endereço fixo, nunca `router.back()`, para o caminho ser o mesmo de qualquer entrada.
 * Voltar de etapa de assistente é outro caso: botão "Voltar" no rodapé do assistente.
 */
export function BackLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("inline-flex min-h-11 items-center gap-1.5 self-start text-[13px] font-semibold text-ink-2 hover:text-ink", className)}
    >
      <Icon name="arrowLeft" size={16} /> {children}
    </Link>
  );
}
