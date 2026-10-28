"use client";

import { Button } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import { Logo } from "@duckzap/ui/components/logo";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export default function OnboardingError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-bg px-4 text-center">
      <Logo />
      <span className="flex size-12 items-center justify-center rounded-full bg-err-bg text-err">
        <Icon name="alert" size={24} />
      </span>
      <h1 className="text-2xl font-extrabold">Não foi possível carregar esta etapa</h1>
      <p className="max-w-sm text-ink-2">
        Pode ser uma falha passageira. O que você já preencheu está guardado.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
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
        <Link href="/entrar" className="inline-flex h-10 items-center px-2 font-semibold underline">
          Ir para Entrar
        </Link>
      </div>
    </main>
  );
}
