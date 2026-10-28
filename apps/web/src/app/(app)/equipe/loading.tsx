import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function TeamLoading() {
  return (
    <Page className="gap-[18px]" aria-busy="true">
      <span className="sr-only">Carregando a equipe…</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-10 w-64 max-w-full" />
      </div>
      <Skeleton className="h-11 w-56" />
      <Card className="flex flex-col gap-3 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-10 flex-1" />
          </div>
        ))}
      </Card>
    </Page>
  );
}
