import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function MoreLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only">Carregando…</span>
      <Skeleton className="h-9 w-32" />
      <Card className="flex flex-col gap-1 p-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </Card>
    </Page>
  );
}
