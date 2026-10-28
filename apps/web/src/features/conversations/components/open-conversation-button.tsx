"use client";

import { Button } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { useState, useTransition } from "react";
import { openConversationAction, type OpenConversationActionError } from "../open-actions";

type Props = {
  contactId: string;
  variant?: "primary" | "ghost";
  size?: "sm";
  className?: string;
};

/**
 * "Abrir conversa": cria/abre/reabre a conversa com o cliente e navega até ela (Server Action com redirect).
 * Mostra o motivo logo abaixo quando não dá (ex.: nenhum canal conectado). Feito para ficar numa linha `flex flex-wrap`:
 * o aviso ocupa a linha inteira.
 */
export function OpenConversationButton({ contactId, variant, size, className }: Props) {
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<OpenConversationActionError | null>(null);

  function open() {
    setFailure(null);
    startTransition(async () => {
      // em caso de sucesso a action redireciona e esta chamada não volta com valor
      const result = await openConversationAction(contactId);
      if (result) setFailure(result);
    });
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={open} disabled={pending} aria-busy={pending} className={className}>
        <Icon name="chat" size={16} />
        {pending ? "Abrindo…" : "Abrir conversa"}
      </Button>
      {failure ? (
        <p role="alert" className="basis-full text-sm text-err">
          {failure.error}{" "}
          {failure.code === "no_channel" ? (
            <Link href="/canais" className="font-semibold underline">
              Ir para Canais
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  );
}
