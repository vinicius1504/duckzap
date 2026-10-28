"use client";

import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { useState, useTransition } from "react";
import { acceptCampaignTermsAction } from "../../actions";

const items = [
  { id: "optin", text: "Só envio para contatos que aceitaram receber mensagens da minha empresa." },
  { id: "bought", text: "Não uso listas compradas nem números sem relação com a empresa." },
  { id: "risk", text: "Entendo que, em números por QR Code, o risco de bloqueio pelo WhatsApp não é zero, mesmo com o envio seguro." },
  { id: "optout", text: "Quem pedir para sair nunca mais recebe campanhas." },
] as const;

/** Aceite dos termos de uso de campanhas, exigido antes do primeiro disparo. */
export function TermsDialog({
  open,
  onOpenChange,
  version,
  onAccepted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  version: string;
  onAccepted: () => void;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const all = items.every((i) => checked[i.id]);

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptCampaignTermsAction();
      if (result.error !== undefined) setError(result.error);
      else onAccepted();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Termos de uso de campanhas" description={`Leia e confirme antes do primeiro disparo (versão ${version}).`}>
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Confirmações</legend>
          {items.map((item) => (
            <label key={item.id} className="flex min-h-11 items-start gap-3">
              <Checkbox
                className="mt-0.5"
                checked={Boolean(checked[item.id])}
                onChange={(e) => setChecked((c) => ({ ...c, [item.id]: e.target.checked }))}
              />
              <span>{item.text}</span>
            </label>
          ))}
        </fieldset>
        <p className="text-[13px] text-ink-2">
          O aceite fica registrado com seu nome, data e hora. As regras de envio seguro rodam no servidor e não podem ser desligadas.
        </p>
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose className={buttonVariants()}>Agora não</DialogClose>
          <Button variant="primary" disabled={!all || pending} onClick={accept}>
            {pending ? <Spinner size={16} /> : null} Aceitar e disparar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
