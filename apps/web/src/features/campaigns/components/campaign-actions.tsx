"use client";

import type { CampaignPauseReason, CampaignStatus } from "@duckzap/contracts/campaigns";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
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

  function run(fn: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
      else {
        setConfirm(null);
        after?.();
      }
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
        <Button key="del" size={size} variant="ghost" onClick={() => setConfirm("delete")} className="text-err">
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
        <p role="alert" className="text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}

      <Dialog open={confirm === "cancel"} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent size="sm" title="Cancelar o envio?" description={`“${name}” para de enviar e não pode ser retomada. O que já foi enviado continua no histórico.`}>
          <DialogFooter>
            <DialogClose className={buttonVariants()}>Voltar</DialogClose>
            <Button variant="primary" disabled={pending} onClick={() => run(() => changeCampaignStatusAction(id, "cancel"))}>
              {pending ? <Spinner size={16} /> : null} Cancelar envio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === "resume"} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent size="sm" title="Retomar a campanha?" description="O envio continua de onde parou, no mesmo ritmo seguro.">
          {reason && pauseReason !== "manual" ? (
            <Alert tone="warn" title={`Ela parou porque: ${reason.title.toLowerCase()}.`}>
              {pauseDetail ? `${pauseDetail} ` : null}
              {reason.hint}
            </Alert>
          ) : null}
          {error ? <Alert tone="err" live>{error}</Alert> : null}
          <DialogFooter>
            <DialogClose className={buttonVariants()}>Agora não</DialogClose>
            <Button variant="primary" disabled={pending || sendingPaused} onClick={() => run(() => changeCampaignStatusAction(id, "resume"))}>
              {pending ? <Spinner size={16} /> : null} Retomar envio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === "delete"} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent size="sm" title="Excluir este rascunho?" description="Não dá para desfazer.">
          <DialogFooter>
            <DialogClose className={buttonVariants()}>Voltar</DialogClose>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => run(() => deleteCampaignDraftAction(id), () => router.push("/campanhas"))}
            >
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
