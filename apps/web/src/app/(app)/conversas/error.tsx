"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";

export default function ConversationsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="px-8 pb-10 pt-7 max-md:px-4">
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">Conversas</h1>
      <Card className="mt-6" role="alert">
        <EmptyState
          icon="alert"
          title="Não deu para carregar as conversas"
          description="Pode ser uma instabilidade momentânea. Suas mensagens estão salvas."
          action={
            <Button variant="primary" onClick={reset}>
              Tentar de novo
            </Button>
          }
        />
      </Card>
    </main>
  );
}
