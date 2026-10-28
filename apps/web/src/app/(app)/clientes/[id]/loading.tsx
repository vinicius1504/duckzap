import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function Loading() {
  return (
    <Page aria-busy="true" aria-label="Carregando ficha do cliente">
      <Skeleton className="h-6 w-24" />
      <Card className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6 max-sm:p-4">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-48 w-full" />
      </Card>
    </Page>
  );
}
