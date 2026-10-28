"use client";

import { Button } from "@duckzap/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { completeOnboardingAction } from "../actions";

/** "Fazer depois": encerra o onboarding agora; o resto se configura dentro do app. */
export function FinishLaterButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog>
      <DialogTrigger className="min-h-11 rounded-control px-2 font-semibold text-ink-2 underline">
        Fazer depois
      </DialogTrigger>
      <DialogContent title="Terminar depois?" size="sm">
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        <p className="text-ink-2">
          Sua conta já está criada. Você pode conectar o WhatsApp e criar o agente depois, em Canais
          e em Agentes de IA.
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button disabled={pending}>Continuar configurando</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await completeOnboardingAction(null);
                if (result) {
                  setError(result.error);
                  return;
                }
                router.replace("/comecar?passo=pronto");
                router.refresh();
              })
            }
          >
            {pending ? <Spinner /> : null}
            Terminar depois
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
