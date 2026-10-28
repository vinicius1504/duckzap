import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function SettingsLoading() {
  return (
    <Page className="max-w-275 gap-[18px]" aria-busy="true">
      <span className="sr-only">Carregando configurações…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-11 w-full" />
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-18 rounded-2xl" />
          <Skeleton className="h-10 w-48" />
        </div>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <Skeleton className="h-10 w-40 self-end" />
      </Card>
    </Page>
  );
}
