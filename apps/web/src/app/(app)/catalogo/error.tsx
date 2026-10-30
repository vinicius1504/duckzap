"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";

export default function CatalogError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Page>
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Catálogo</h1>
      <Card role="alert">
        <EmptyState
          icon="alert"
          title="Não deu para carregar o catálogo"
          description="Pode ser a conexão. Seus produtos estão salvos."
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
