import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

const field = "w-full rounded-control border border-field bg-surface text-ink placeholder:text-ink-2 disabled:opacity-60";

export function Textarea({
  className,
  invalid,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(field, "resize-y px-3 py-2.5", invalid && "border-err", className)}
      {...props}
    />
  );
}

/** Select nativo estilizado: acessível e bom no celular. */
export function Select({
  className,
  invalid,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(field, "h-10 px-3", invalid && "border-err", className)}
      {...props}
    />
  );
}

export function Checkbox({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="checkbox" className={cn("size-[18px] shrink-0 accent-ink", className)} {...props} />;
}

export function Radio({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="radio" className={cn("size-[18px] shrink-0 accent-ink", className)} {...props} />;
}
