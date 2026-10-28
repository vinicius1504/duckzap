"use client";

import type { Channel } from "@duckzap/contracts/channels";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import Link from "next/link";
import { ConfirmDialog } from "@/features/settings/components/confirm-dialog";
import { deleteChannelAction, disconnectChannelAction, setDefaultChannelAction } from "../actions";
import { ConnectDialog } from "./connect-dialog";

export function ChannelRowActions({ channel }: { channel: Channel }) {
  const connected = channel.status === "connected";
  const canBeDefault = connected && !channel.isDefault && channel.type !== "instagram";

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {!connected && channel.status !== "banned" ? <ConnectDialog channel={channel} /> : null}
      <Link
        href={`/canais?canal=${channel.id}#mensagens`}
        scroll={false}
        className={buttonVariants({ size: "sm" })}
        aria-label={`Mensagens e vínculo: ${channel.name}`}
      >
        Mensagens
      </Link>
      {canBeDefault ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="ghost" aria-label={`Tornar padrão: ${channel.name}`}>
              Tornar padrão
            </Button>
          }
          title={`Tornar ${channel.name} o canal padrão?`}
          description="Conversas iniciadas pelo Duckzap (lembretes, campanhas e novos contatos) saem por este número."
          confirmLabel="Tornar padrão"
          onConfirm={() => setDefaultChannelAction(channel.id)}
        />
      ) : null}
      {connected ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" aria-label={`Desconectar: ${channel.name}`}>
              Desconectar
            </Button>
          }
          title={`Desconectar ${channel.name}?`}
          description="As mensagens deste canal deixam de chegar até você reconectar. Conversas e contatos continuam salvos."
          confirmLabel="Desconectar"
          danger
          onConfirm={() => disconnectChannelAction(channel.id)}
        />
      ) : null}
      {!connected ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="ghost" className="text-err" aria-label={`Excluir: ${channel.name}`}>
              Excluir
            </Button>
          }
          title={`Excluir ${channel.name}?`}
          description="O canal sai da lista e libera uma vaga do plano. As conversas continuam salvas. Novas mensagens sairão pelo número que você conectar depois."
          confirmLabel="Excluir canal"
          danger
          onConfirm={() => deleteChannelAction(channel.id)}
        />
      ) : null}
    </div>
  );
}
