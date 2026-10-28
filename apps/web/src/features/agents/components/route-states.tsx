"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState, Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import { useEffect } from "react";

export function AgentsSkeleton({ variant = "list" }: { variant?: "list" | "detail" }) {
  return (
    <Page aria-busy="true" aria-label="Carregando agentes">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {variant === "list" ? (
        <div className="flex flex-wrap gap-6">
          <div className="grid min-w-0 flex-[3_1_560px] gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr))]">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          </div>
          <Skeleton className="h-56 min-w-0 flex-[1_1_280px]" />
        </div>
      ) : (
        <div className="flex gap-6">
          <div className="flex w-64 shrink-0 flex-col gap-2 max-lg:hidden">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap gap-6">
            <Skeleton className="h-[520px] min-w-0 flex-[2_1_520px]" />
            <Skeleton className="h-[520px] min-w-0 flex-[1_1_320px] max-xl:hidden" />
          </div>
        </div>
      )}
    </Page>
  );
}

export function AgentsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Page>
      <Card>
        <EmptyState
          icon="alert"
          title="Não deu para carregar os agentes"
          description="Pode ser uma falha passageira. Os agentes continuam respondendo normalmente."
          action={
            <Button variant="primary" onClick={reset}>
              Tentar de novo
            </Button>
          }
        />
      </Card>
    </Page>
  );
}
