import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function ChannelsLoading() {
  return (
    <Page className="gap-[18px]" aria-busy="true">
      <span className="sr-only">Carregando canais…</span>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <Skeleton className="h-11 w-full" />
      <Card className="flex flex-col gap-3 p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
      <div className="flex flex-wrap items-start gap-5">
        <Skeleton className="h-80 min-w-0 flex-[2_1_520px] rounded-card" />
        <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <Skeleton className="h-36 w-full rounded-card" />
          <Skeleton className="h-28 w-full rounded-card" />
        </div>
      </div>
    </Page>
  );
}
