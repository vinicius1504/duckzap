"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState, Skeleton } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import { useEffect } from "react";

/** Esqueleto genérico das telas de Campanhas: título, abas e um bloco de conteúdo. */
export function CampaignsSkeleton({ variant = "list" }: { variant?: "list" | "wizard" | "detail" }) {
  return (
    <Page aria-busy="true" aria-label="Carregando campanhas">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {variant === "wizard" ? (
        <Card className="flex flex-col gap-5 p-6">
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

export function CampaignsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Page>
      <Card>
        <EmptyState
          icon="alert"
          title="Não deu para carregar as campanhas"
          description="Pode ser uma falha passageira. Nenhum envio foi afetado."
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
