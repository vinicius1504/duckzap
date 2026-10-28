"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn";
import { Icon } from "./icon";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

type ContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  title: string;
  description?: ReactNode;
  /** "center": modal; "right": gaveta lateral (painéis de detalhe, ficha de cliente). */
  side?: "center" | "right";
  size?: "sm" | "md" | "lg";
};

const sizes = { sm: "w-[min(440px,100%)]", md: "w-[min(560px,100%)]", lg: "w-[min(820px,100%)]" };

export function DialogContent({
  title,
  description,
  side = "center",
  size = "md",
  className,
  children,
  ...props
}: ContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgba(15,31,43,.55)]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col gap-4 overflow-y-auto border border-line bg-surface text-ink shadow-xl focus:outline-none",
          side === "center" &&
            cn(
              "left-1/2 top-1/2 max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 rounded-card p-6 max-sm:p-4",
              sizes[size],
            ),
          side === "right" && "inset-y-0 right-0 w-[min(460px,100%)] p-6 max-sm:p-4",
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="text-xl font-extrabold">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-ink-2">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            aria-label="Fechar"
            className="flex size-9 shrink-0 items-center justify-center rounded-control border border-line bg-surface hover:bg-surface-hover"
          >
            <Icon name="close" size={16} strokeWidth={2} />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-2 flex flex-wrap justify-end gap-2", className)} {...props} />;
}
