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
import { signOutAction } from "@/features/auth/actions";
import { completeOnboardingAction } from "../actions";

/**
 * "Fazer depois". O cadastro é obrigatório, mas só a empresa é indispensável:
 *  - com a empresa criada (`canFinish`): conclui agora (gravado no banco) e o WhatsApp e o agente ficam para Canais e Agentes de IA;
 *  - sem empresa ainda: não há o que concluir, então SAI. O progresso fica salvo e, ao entrar de novo, a pessoa volta para cá.
 */
export function FinishLaterButton({ canFinish }: { canFinish: boolean }) {
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
          {canFinish
            ? "Sua conta e sua empresa já estão criadas. Você pode conectar o WhatsApp e criar o agente depois, em Canais e em Agentes de IA."
            : "Sua conta já está criada, falta só a empresa. Você sai agora e, quando entrar de novo, continua daqui."}
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
                if (!canFinish) {
                  await signOutAction();
                  return;
                }
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
            {pending ? <Spinner size={16} /> : null}
            {canFinish ? "Terminar depois" : "Sair e terminar depois"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
