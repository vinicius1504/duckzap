"use client";

import type { Channel } from "@duckzap/contracts/channels";
import { Button, type ButtonProps } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { useState } from "react";
import { ConnectStep } from "./connect-step";
import { connectLabel } from "./labels";

/** Reconectar / conectar / autorizar um canal que já existe. */
export function ConnectDialog({
  channel,
  label,
  variant = "primary",
  size = "sm",
}: {
  channel: Pick<Channel, "id" | "name" | "type" | "status">;
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
}) {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const action = label ?? connectLabel(channel.type, channel.status);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConnected(false);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} size={size} aria-label={`${action}: ${channel.name}`}>
          {action}
        </Button>
      </DialogTrigger>
      <DialogContent title={`${connectLabel(channel.type, channel.status)} ${channel.name}`} size="md">
        {connected ? (
          <Alert tone="ok" live title="Pronto!">
            {channel.name} está conectado e já recebe mensagens.
          </Alert>
        ) : (
          // só monta o QR com o diálogo aberto: gerar código é uma chamada ao provedor
          <ConnectStep channel={channel} onConnected={() => setConnected(true)} />
        )}
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>{connected ? "Concluir" : "Fechar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
