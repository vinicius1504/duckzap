"use client";

import { cn } from "@duckzap/ui/cn";
import { TabsList, TabsTrigger } from "@duckzap/ui/components/tabs";
import type { ComponentProps } from "react";

// Abas com cara de seletor segmentado (como o do MillionZap), mas com a semântica de abas de verdade: `tablist`, setas do
// teclado e o painel ligado à aba. Só troca o visual das `Tabs` do packages/ui.

export function SegmentedTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return <TabsList className={cn("w-full gap-0.5 rounded-control border-b-0 bg-surface-2 p-[3px]", className)} {...props} />;
}

export function SegmentedTabsTrigger({ className, ...props }: ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "relative mb-0 h-10 flex-1 rounded-lg border-b-0 px-3 text-center data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-[0_1px_2px_rgba(15,31,43,.15)] max-md:h-11",
        className,
      )}
      {...props}
    />
  );
}
