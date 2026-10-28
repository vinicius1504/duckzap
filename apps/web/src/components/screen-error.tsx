"use client";

import { Button } from "@duckzap/ui/components/button";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { useEffect } from "react";

/**
 * Tela cheia de erro/indisponibilidade (usada por `app/error.tsx`, que também pega erro do layout autenticado,
 * por exemplo API fora do ar). Não diz "sessão expirada": a pessoa continua logada, só precisa tentar de novo.
 */
export function ScreenError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div role="alert" className="w-full max-w-md rounded-card border border-line bg-surface">
        <EmptyState
          icon="alert"
          title="Serviço indisponível"
          description="Não conseguimos carregar esta página agora. Pode ser uma falha passageira; seus dados estão seguros."
          action={
            <Button variant="primary" onClick={() => retry()}>
              Tentar de novo
            </Button>
          }
        />
      </div>
    </main>
  );
}
