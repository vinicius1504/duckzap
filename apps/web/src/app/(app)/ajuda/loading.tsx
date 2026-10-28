import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function HelpLoading() {
  return (
    <Page className="max-w-275" aria-busy="true">
      <span className="sr-only">Carregando a ajuda…</span>
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-11 w-full max-w-160" />
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_520px] flex-col gap-5">
          <Card className="flex flex-col gap-4 p-[22px]">
            <Skeleton className="h-5 w-48" />
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </Card>
          <Card className="grid gap-3.5 p-[22px] [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="aspect-video w-full" />
            ))}
          </Card>
        </div>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
          <Skeleton className="h-80 w-full rounded-card" />
          <Skeleton className="h-72 w-full rounded-card" />
        </div>
      </div>
    </Page>
  );
}
