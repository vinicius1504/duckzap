"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Page, pageTitleClass } from "@duckzap/ui/components/layout";
import { Logo } from "@duckzap/ui/components/logo";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

/**
 * Props que o Next entrega a todo `error.tsx`. Use `retry` (recomendado pela documentação do Next 16: busca os dados de novo);
 * `reset` só limpa o erro sem buscar. Cada `error.tsx` de rota fica em UMA linha: `<RouteError title="Agenda" error={error} retry={retry} />`.
 */
export type RouteErrorProps = { error: unknown; retry: () => void };

/** Corpo comum dos `error.tsx` das rotas internas (dentro do app). */
export function RouteError({ title, error, retry }: { title: string } & RouteErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Page>
      <h1 className={pageTitleClass}>{title}</h1>
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

/** Corpo comum dos `error.tsx` das telas de fora do app (entrar, começar, esqueci a senha): tela cheia, com a marca. */
export function AuthRouteError({ title, description, error, retry }: { title: string; description: string } & RouteErrorProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg px-4 text-center">
      <Logo />
      <span className="flex size-12 items-center justify-center rounded-full bg-err-bg text-err">
        <Icon name="alert" size={24} />
      </span>
      <h1 className="text-2xl font-extrabold">{title}</h1>
      <p className="max-w-sm text-ink-2">{description}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            startTransition(() => {
              router.refresh();
              retry();
            })
          }
        >
          <Icon name="refresh" size={16} />
          Tentar de novo
        </Button>
        <Link href="/entrar" className="inline-flex h-10 items-center px-2 font-semibold underline">
          Ir para Entrar
        </Link>
      </div>
    </main>
  );
}
