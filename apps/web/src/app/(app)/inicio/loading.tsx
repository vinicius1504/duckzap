import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function HomeLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only">Carregando…</span>
      <Skeleton className="h-9 w-72" />
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[2_1_620px] flex-col gap-6">
          <Card padding="md" className="flex flex-col gap-3">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </Card>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr))]">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-card" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-card" />
        </div>
        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <Skeleton className="h-64 w-full rounded-card" />
          <Skeleton className="h-48 w-full rounded-card" />
        </aside>
      </div>
    </Page>
  );
}
