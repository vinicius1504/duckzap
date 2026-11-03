"use client";

import { useState, useTransition, type ReactElement, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "./dialog";
import { Alert } from "./feedback";

type Outcome = { ok: true } | { ok?: false; error: string };

/**
 * Confirmação de ação destrutiva ou sensível (padrão único do produto). Fica aberta e mostra o erro DENTRO da janela se a ação
 * falhar. `danger` deixa o botão de confirmar vermelho (Excluir, Desativar, Desconectar, Cancelar envio).
 *
 * Duas formas de abrir: `trigger` (o botão que abre) ou controlado (`open` + `onOpenChange`, para abrir a partir de um menu).
 */
export function ConfirmDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel = "Aguarde…",
  danger,
  onConfirm,
  children,
}: {
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Texto do botão enquanto a ação roda (ex.: "Excluindo…"). */
  pendingLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<Outcome>;
  children?: ReactNode;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const open = controlledOpen ?? innerOpen;

  function setOpen(next: boolean) {
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
    if (!next) setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent title={title} description={description} size="sm">
        {children}
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button>Cancelar</Button>
          </DialogClose>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await onConfirm();
                if (result.ok) setOpen(false);
                else setError(result.error);
              })
            }
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
