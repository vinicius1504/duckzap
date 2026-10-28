"use client";

import type { InboxLookups, TransferTarget } from "@duckzap/contracts/conversations";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Radio, Textarea } from "@duckzap/ui/components/form-controls";
import { Label } from "@duckzap/ui/components/input";
import { Segmented } from "@duckzap/ui/components/segmented";
import { Spinner } from "@duckzap/ui/components/feedback";
import { useState, useTransition, type FormEvent } from "react";
import { transferConversationAction } from "../actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactName: string;
  lookups: InboxLookups;
  currentAssigneeId: string | null;
  viewerId: string;
};

export function TransferDialog({ open, onOpenChange, conversationId, contactName, lookups, currentAssigneeId, viewerId }: Props) {
  const [kind, setKind] = useState<TransferTarget["kind"]>("member");
  const [choice, setChoice] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const members = lookups.members.filter((m) => m.id !== currentAssigneeId && m.id !== viewerId);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice) {
      setError(kind === "member" ? "Escolha a pessoa." : "Escolha a equipe.");
      return;
    }
    const target: TransferTarget = kind === "member" ? { kind, memberId: choice } : { kind, teamId: choice };
    startTransition(async () => {
      const result = await transferConversationAction(conversationId, target, note);
      if (result) setError(result.error);
      else {
        setNote("");
        setChoice(null);
        onOpenChange(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent title="Transferir conversa" description={`Quem vai continuar o atendimento de ${contactName}?`} size="sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Segmented
            label="Transferir para"
            options={[
              { value: "member", label: "Pessoa" },
              { value: "team", label: "Equipe" },
            ]}
            value={kind}
            onChange={(value) => {
              setKind(value);
              setChoice(null);
              setError(null);
            }}
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{kind === "member" ? "Pessoa" : "Equipe"}</legend>
            {(kind === "member" ? members : lookups.teams).map((option) => {
              const member = kind === "member" ? lookups.members.find((m) => m.id === option.id) : undefined;
              const detail = member
                ? `${member.teamIds.map((t) => lookups.teams.find((x) => x.id === t)?.name).filter(Boolean).join(", ")} · ${member.online ? "online" : "offline"}`
                : `${lookups.members.filter((m) => m.teamIds.includes(option.id)).length} pessoas · entra na fila de espera`;
              return (
                <label
                  key={option.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-control border border-line px-3 py-2 hover:bg-surface-hover has-[:checked]:border-ink"
                >
                  <Radio name="transfer-target" value={option.id} checked={choice === option.id} onChange={() => setChoice(option.id)} />
                  <span className="flex-1">
                    <span className="block font-semibold">{option.name}</span>
                    <span className="block text-xs text-ink-2">{detail}</span>
                  </span>
                  {member ? (
                    <span
                      aria-hidden="true"
                      className={member.online ? "size-2.5 rounded-full bg-ok" : "size-2.5 rounded-full bg-field"}
                    />
                  ) : null}
                </label>
              );
            })}
          </fieldset>
          <div>
            <Label htmlFor="transfer-note">Nota para quem recebe (opcional)</Label>
            <Textarea
              id="transfer-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex.: quer orçamento de implante, prefere contato à tarde"
            />
            <p className="mt-1 text-xs text-ink-2">Vira uma nota interna: o cliente não vê.</p>
          </div>
          {error ? (
            <p role="alert" className="text-[13px] font-semibold text-err">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? <Spinner size={16} /> : null}
              Transferir
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
