import { cn } from "../lib/cn";

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const sizes = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-14 text-lg" };

/**
 * Avatar redondo de tamanho fixo (sem salto de layout). Sem `src` mostra as iniciais. Com `src` a foto fica POR CIMA das
 * iniciais: se ela faltar, expirar (URL assinada) ou der erro, o que aparece são as iniciais que estão por baixo, sem precisar
 * de estado no cliente (por isso este componente continua servindo também a Server Components). A foto é decorativa
 * (`alt=""`): o nome da pessoa sempre aparece ao lado.
 */
export function Avatar({
  name,
  src,
  size = "md",
  tone = "neutral",
  className,
}: {
  name: string;
  /** URL da foto (https ou assinada); null/undefined/"" = só as iniciais. */
  src?: string | null | undefined;
  size?: keyof typeof sizes;
  tone?: "neutral" | "brand";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-extrabold",
        tone === "brand" ? "bg-rail text-duck" : "bg-surface-2 text-ink",
        sizes[size],
        className,
      )}
    >
      {initialsOf(name)}
      {src ? (
        // <img> simples: URL assinada de outro domínio, não serve para next/image. Sem fundo próprio de propósito (falhou = iniciais)
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className="absolute inset-0 size-full rounded-full object-cover"
        />
      ) : null}
    </span>
  );
}
