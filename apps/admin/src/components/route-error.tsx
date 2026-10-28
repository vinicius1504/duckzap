"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Icon } from "@duckzap/ui/components/icon";
import { Page } from "@duckzap/ui/components/layout";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Corpo comum dos `error.tsx` do painel. */
export function RouteError({ title, reset }: { title: string; reset: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Page>
      <h1 className="text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">{title}</h1>
      <Card role="alert" className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-err-bg text-err">
          <Icon name="alert" size={24} />
        </span>
        <p className="font-bold">Não foi possível carregar esta página</p>
        <p className="max-w-sm text-ink-2">
          Pode ser uma falha passageira. Tente de novo em alguns segundos.
        </p>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            startTransition(() => {
              router.refresh();
              reset();
            })
          }
        >
          <Icon name="refresh" size={18} />
          Tentar de novo
        </Button>
      </Card>
    </Page>
  );
}
