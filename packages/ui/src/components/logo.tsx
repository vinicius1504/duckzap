import { brand } from "@duckzap/brand";
import { cn } from "../lib/cn";

/** Marca do pato. `tone="onDark"` para fundos escuros (rail). */
export function LogoMark({ size = 36, tone = "default" }: { size?: number; tone?: "default" | "onDark" }) {
  const plate = tone === "onDark" ? "#FFC42E" : "var(--logo-plate)";
  const duck = tone === "onDark" ? "#0F1F2B" : "var(--logo-duck)";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill={plate} />
      <path d="M8 22c3 3.4 10 3.4 14-1l-2-4H9z" fill={duck} />
      <circle cx="15" cy="13" r="6.5" fill={duck} />
      <path d="M20.5 12l6 2.2-6 2.6z" fill="#FF8A2E" />
      <circle cx="13" cy="11.8" r="1.3" fill={plate} />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-xl font-extrabold tracking-[-0.02em]", className)}>
      <LogoMark />
      {brand.name}
    </span>
  );
}
