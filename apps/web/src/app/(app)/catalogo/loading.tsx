import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function Loading() {
  return (
    <Page aria-busy="true" aria-label="Carregando catálogo">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-full max-w-lg" />
      </div>
      <Skeleton className="h-6 w-32" />
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))]">
        <Skeleton className="h-44 rounded-card" />
        <Skeleton className="h-44 rounded-card" />
        <Skeleton className="h-44 rounded-card" />
      </div>
    </Page>
  );
}
