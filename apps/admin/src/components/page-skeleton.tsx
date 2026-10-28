import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

/** Corpo comum dos `loading.tsx`: título, filtros e linhas de tabela. */
export function ListSkeleton({
  label,
  rows = 6,
  withKpis = false,
}: {
  label: string;
  rows?: number;
  withKpis?: boolean;
}) {
  return (
    <Page aria-busy="true" aria-label={label}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-9 w-56" />
      {withKpis ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-10 w-[min(520px,100%)]" />
        <Skeleton className="h-10 w-[min(320px,100%)]" />
      </div>
      <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </Page>
  );
}
