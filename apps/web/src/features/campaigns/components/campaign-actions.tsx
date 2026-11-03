"use client";

import type { CampaignPauseReason, CampaignStatus } from "@duckzap/contracts/campaigns";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { ConfirmDialog } from "@duckzap/ui/components/confirm-dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { changeCampaignStatusAction, deleteCampaignDraftAction, duplicateCampaignAction } from "../actions";
import { pauseReasonView } from "../labels";

type Props = {
  id: string;
  name: string;
  status: CampaignStatus;
  pauseReason: CampaignPauseReason | null;
  pauseDetail: string | null;
  /** Motivo de disparo/retomada indisponível (plano expirado, sem permissão); null = liberado. */
  sendBlockedReason: string | null;
  /** "row": só a ação principal (tabela); "detail": todas. */
  layout?: "row" | "detail";
};

export function CampaignActions({ id, name, status, pauseReason, pauseDetail, sendBlockedReason, layout = "row" }: Props) {
  const sendingPaused = sendBlockedReason !== null;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"cancel" | "resume" | "delete" | null>(null);
  const size = layout === "row" ? "sm" : "md";

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }

  function duplicate() {
    setError(null);
    startTransition(async () => {
      const result = await duplicateCampaignAction(id);
      if (result.error !== undefined) setError(result.error);
      else router.push(`/campanhas/nova?rascunho=${result.data.id}`);
    });
  }

  /** Resultado das Server Actions de Campanhas (`{ error?: string }`) no formato do ConfirmDialog. */
  const outcome = (result: { error?: string }) => (result.error ? { error: result.error } : { ok: true as const });

  const reason = pauseReason ? pauseReasonView[pauseReason] : null;
  const row = layout === "row";
  const live = status === "sending" || status === "scheduled" || status === "paused";
  const actions: ReactNode[] = [];

  if (status === "draft") {
    actions.push(
      <Link key="edit" href={`/campanhas/nova?rascunho=${id}`} className={buttonVariants({ size, variant: row ? "secondary" : "primary" })}>
        Continuar
      </Link>,
    );
    if (!row)
      actions.push(
        <Button key="del" size={size} variant="danger-ghost" onClick={() => setConfirm("delete")}>
          <Icon name="trash" size={16} /> Excluir rascunho
        </Button>,
      );
  }
  if (status === "sending") {
    actions.push(
      <Button key="pause" size={size} disabled={pending} onClick={() => run(() => changeCampaignStatusAction(id, "pause"))}>
        <Icon name="pause" size={16} /> Pausar
      </Button>,
    );
  }
  if (status === "paused") {
    actions.push(
      <Button
        key="resume"
        size={size}
        variant={row ? "secondary" : "primary"}
        disabled={pending || sendingPaused}
        title={sendBlockedReason ?? undefined}
        onClick={() => setConfirm("resume")}
      >
        <Icon name="play" size={16} /> Retomar
      </Button>,
    );
  }
  if (live && !row) {
    actions.push(
      <Button key="cancel" size={size} disabled={pending} onClick={() => setConfirm("cancel")}>
        Cancelar envio
      </Button>,
    );
  }
  if (row && (status === "completed" || status === "canceled")) {
    actions.push(
      <Link key="view" href={`/campanhas/${id}`} className={buttonVariants({ size })}>
        Ver status
      </Link>,
    );
  }
  if ((row && status === "scheduled") || (!row && status !== "draft")) {
    actions.push(
      <Button key="dup" size={size} variant={row ? "secondary" : "ghost"} disabled={pending} onClick={duplicate}>
        <Icon name="copy" size={16} /> Duplicar
      </Button>,
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", layout === "row" ? "items-end" : "items-start")}>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        {pending ? <Spinner size={16} /> : null}
      </div>
      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}

      <ConfirmDialog
        danger
        open={confirm === "cancel"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Cancelar o envio?"
        description={`“${name}” para de enviar e não pode ser retomada. O que já foi enviado continua no histórico.`}
        confirmLabel="Cancelar envio"
        pendingLabel="Cancelando…"
        onConfirm={async () => outcome(await changeCampaignStatusAction(id, "cancel"))}
      />

      <ConfirmDialog
        open={confirm === "resume"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Retomar a campanha?"
        description="O envio continua de onde parou, no mesmo ritmo seguro."
        confirmLabel="Retomar envio"
        pendingLabel="Retomando…"
        onConfirm={async () => outcome(await changeCampaignStatusAction(id, "resume"))}
      >
        {reason && pauseReason !== "manual" ? (
          <Alert tone="warn" title={`Ela parou porque: ${reason.title.toLowerCase()}.`}>
            {pauseDetail ? `${pauseDetail} ` : null}
            {reason.hint}
          </Alert>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        danger
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Excluir este rascunho?"
        description="Não dá para desfazer."
        confirmLabel="Excluir"
        pendingLabel="Excluindo…"
        onConfirm={async () => {
          const result = outcome(await deleteCampaignDraftAction(id));
          if (result.ok) router.push("/campanhas");
          return result;
        }}
      />
    </div>
  );
}
