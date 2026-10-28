"use client";

import { cn } from "../lib/cn";

type Option<T extends string> = { value: T; label: string };

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-control bg-surface-2 p-[3px]">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-[34px] rounded-lg px-3.5 font-semibold text-ink-2",
              active && "bg-surface text-ink shadow-[0_1px_2px_rgba(15,31,43,.15)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
