import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function Loading() {
  return (
    <Page className="gap-[18px]" aria-busy="true" aria-label="Carregando clientes">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-36" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>
      <Skeleton className="h-11 w-full max-w-xs" />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-10 flex-[1_1_260px]" />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-36" />
        ))}
      </div>
      <div className="flex flex-col gap-px overflow-hidden rounded-card border border-line">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-none" />
        ))}
      </div>
    </Page>
  );
}
