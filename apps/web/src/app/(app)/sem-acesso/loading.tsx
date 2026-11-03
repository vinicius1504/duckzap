import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function NoAccessLoading() {
  return (
    <Page aria-busy="true">
      <span className="sr-only">Carregando…</span>
      <Card padding="lg">
        <Skeleton className="mx-auto h-40 w-full max-w-sm" />
      </Card>
    </Page>
  );
}
