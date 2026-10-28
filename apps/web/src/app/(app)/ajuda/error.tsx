"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import { useEffect } from "react";

export default function AjudaError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Page>
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">Ajuda</h1>
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
