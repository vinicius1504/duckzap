import { Card } from "@duckzap/ui/components/card";
import { Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

/** Esqueleto genérico das telas de Campanhas: título, abas e um bloco de conteúdo. */
export function CampaignsSkeleton({ variant = "list" }: { variant?: "list" | "wizard" | "detail" }) {
  return (
    <Page aria-busy="true">
      <span className="sr-only">Carregando campanhas…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {variant === "wizard" ? (
        <Card padding="lg" className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-7 w-28" />
            ))}
          </div>
          <Skeleton className="h-11 w-full max-w-xl" />
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr))]">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        </Card>
      ) : (
        <>
          {variant === "detail" ? <Skeleton className="h-40 w-full" /> : null}
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-24" />
            ))}
          </div>
          <div className="flex flex-wrap gap-6">
            <Skeleton className="h-80 min-w-0 flex-[2_1_560px]" />
            <Skeleton className="h-64 min-w-0 flex-[1_1_280px]" />
          </div>
        </>
      )}
    </Page>
  );
}
