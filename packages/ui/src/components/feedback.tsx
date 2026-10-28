import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "./icon";

const alertTones = {
  info: "bg-info-bg text-info",
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  err: "bg-err-bg text-err",
};

/** Faixa de aviso. `live` (role="alert") só para o que acabou de acontecer, como um erro de envio. */
export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
  live,
}: {
  tone?: keyof typeof alertTones;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  live?: boolean;
}) {
  return (
    <div
      role={live ? "alert" : undefined}
      className={cn("flex flex-wrap items-center gap-3 rounded-control px-3.5 py-2.5", alertTones[tone], className)}
    >
      {title ? <strong>{title}</strong> : null}
      {children ? <span className="flex-[1_1_200px]">{children}</span> : null}
      {action}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-2">
        <Icon name={icon} size={24} />
      </span>
      <p className="font-bold">{title}</p>
      {description ? <p className="max-w-sm text-ink-2">{description}</p> : null}
      {action}
    </div>
  );
}

export function Progress({
  value,
  max = 100,
  label,
  tone = "ink",
}: {
  value: number;
  max?: number;
  label: string;
  tone?: "ink" | "duck" | "ok" | "err";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const bar = { ink: "bg-ink", duck: "bg-duck", ok: "bg-ok", err: "bg-err" }[tone];
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className="h-2 rounded bg-surface-2"
    >
      <div className={cn("h-2 rounded", bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-control bg-surface-2", className)} />;
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden="true"
      className="animate-spin"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
