"use client";

import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { useState, useTransition, type ReactElement, type ReactNode } from "react";

type Outcome = { ok: true } | { ok?: false; error: string };

/**
 * Confirmação de ação destrutiva ou sensível. Fica aberta e mostra o erro se a ação falhar.
 * Candidato a componente compartilhado (`@duckzap/ui`).
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
  children,
}: {
  trigger: ReactElement;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<Outcome>;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
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
            variant={danger ? "secondary" : "primary"}
            className={danger ? "border-err bg-err text-bg hover:bg-err hover:opacity-90" : undefined}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await onConfirm();
                if (result.ok) setOpen(false);
                else setError(result.error);
              })
            }
          >
            {pending ? "Aguarde…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
