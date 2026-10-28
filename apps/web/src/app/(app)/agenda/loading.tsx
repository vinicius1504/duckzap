import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function Loading() {
  return (
    <Page className="gap-[18px]" aria-busy="true" aria-label="Carregando agenda">
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_680px] flex-col gap-3">
          <div className="flex flex-wrap justify-between gap-3">
            <Skeleton className="h-9 w-72" />
            <Skeleton className="h-10 w-96 max-w-full" />
          </div>
          <Skeleton className="h-[560px] w-full rounded-card" />
        </div>
        <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 lg:max-w-[340px]">
          <Skeleton className="h-36 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
          <Skeleton className="h-72 rounded-card" />
        </div>
      </div>
    </Page>
  );
}
