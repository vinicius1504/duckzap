"use client";

import { Button } from "@duckzap/ui/components/button";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { useEffect } from "react";

/** Tela cheia de erro/indisponibilidade (API fora do ar, falha no layout). Não derruba a sessão. */
export function ScreenError({ error, reset }: { error: unknown; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div role="alert" className="w-full max-w-md rounded-card border border-line bg-surface">
        <EmptyState
          icon="alert"
          title="Serviço indisponível"
          description="Não conseguimos falar com a API agora. Tente de novo em instantes."
          action={
            <Button variant="primary" onClick={() => reset()}>
              Tentar de novo
            </Button>
          }
        />
      </div>
    </main>
  );
}
