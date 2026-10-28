import { cn } from "../lib/cn";

export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const sizes = { sm: "size-8 text-xs", md: "size-10 text-sm", lg: "size-14 text-lg" };

export function Avatar({
  name,
  size = "md",
  tone = "neutral",
  className,
}: {
  name: string;
  size?: keyof typeof sizes;
  tone?: "neutral" | "brand";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-extrabold",
        tone === "brand" ? "bg-rail text-duck" : "bg-surface-2 text-ink",
        sizes[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
