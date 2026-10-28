"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import { useEffect } from "react";

/** Corpo comum dos `error.tsx` das rotas internas. */
export function RouteError({ title, error, retry }: { title: string; error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Page>
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">{title}</h1>
      <Card role="alert">
        <EmptyState
          icon="alert"
          title="Não foi possível carregar esta tela"
          description="Pode ser uma falha momentânea de conexão. Seus dados estão seguros."
          action={
            <Button variant="primary" onClick={() => retry()}>
              Tentar de novo
            </Button>
          }
        />
      </Card>
    </Page>
  );
}
