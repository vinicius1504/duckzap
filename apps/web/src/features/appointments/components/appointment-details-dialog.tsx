"use client";

import type { Appointment, AppointmentStatus } from "@duckzap/contracts/appointments";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogContent } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { OpenConversationButton } from "@/features/conversations/components/open-conversation-button";
import { formatDate, formatPhone } from "@/lib/format";
import { sourceLabel, statusActions, statusView } from "../labels";
import { zonedTime } from "../time";

export function AppointmentDetailsDialog({
  appointment,
  onOpenChange,
  typeName,
  ownerName,
  conflict,
  timeZone,
  canManage,
  pending,
  error,
  onStatus,
  onEdit,
}: {
  appointment: Appointment | null;
  onOpenChange: (open: boolean) => void;
  typeName: (id: string) => string;
  ownerName: (id: string) => string;
  conflict: boolean;
  timeZone: string;
  canManage: boolean;
  pending: boolean;
  error: string | null;
  onStatus: (id: string, status: AppointmentStatus) => void;
  onEdit: (appointment: Appointment) => void;
}) {
  const a = appointment;
  return (
    <Dialog open={Boolean(a)} onOpenChange={onOpenChange}>
      {a ? (
        <DialogContent title={`${typeName(a.typeId)} · ${a.contactName}`} size="sm">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={statusView[a.status].tone}>{statusView[a.status].label}</Chip>
            {conflict ? <Chip tone="err">Conflito de horário</Chip> : null}
            <Chip tone={a.syncedToGoogle ? "ok" : "neutral"}>{a.syncedToGoogle ? "No Google Calendar" : "Ainda não sincronizado"}</Chip>
          </div>

          <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-3 gap-y-2 text-[13px]">
            <dt className="text-ink-2">Quando</dt>
            <dd className="first-letter:uppercase">
              {formatDate(a.startsAt, { weekday: "long", day: "2-digit", month: "2-digit" }, timeZone)}, {zonedTime(a.startsAt, timeZone)}–
              {zonedTime(a.endsAt, timeZone)}
            </dd>
            <dt className="text-ink-2">Responsável</dt>
            <dd>{ownerName(a.ownerId)}</dd>
            <dt className="text-ink-2">Telefone</dt>
            <dd>{a.contactPhone ? formatPhone(a.contactPhone) : "—"}</dd>
            <dt className="text-ink-2">Origem</dt>
            <dd>
              {sourceLabel[a.source]}
              {a.sourceName ? ` ${a.sourceName}` : ""}
            </dd>
            {a.notes ? (
              <>
                <dt className="text-ink-2">Observações</dt>
                <dd>{a.notes}</dd>
              </>
            ) : null}
          </dl>

          <section className="rounded-control border border-line p-3">
            <h3 className="text-[13px] font-bold">Lembretes</h3>
            {a.reminders.length ? (
              <ul className="mt-1.5 flex flex-col gap-1 text-[13px]">
                {a.reminders.map((r) => (
                  <li key={r.kind} className="flex flex-wrap justify-between gap-2">
                    <span>{r.kind === "24h" ? "24 h antes" : "2 h antes"}</span>
                    <span className="text-ink-2">
                      {r.status === "sent" ? "Enviado" : r.status === "scheduled" ? "Agendado" : "Não enviado"} ·{" "}
                      {formatDate(r.at, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }, timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] text-ink-2">Sem lembretes para este agendamento.</p>
            )}
            <p className="mt-2 text-[13px]">
              {a.confirmationReply ? (
                <>
                  Resposta do cliente: <strong>“{a.confirmationReply}”</strong>
                </>
              ) : (
                <span className="text-ink-2">O cliente ainda não respondeu.</span>
              )}
            </p>
          </section>

          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}

          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {statusActions[a.status].map((action) => (
                <Button
                  key={action.to}
                  variant={action.primary ? "primary" : "secondary"}
                  disabled={pending}
                  onClick={() => onStatus(a.id, action.to)}
                  className="max-md:h-11"
                >
                  {action.label}
                </Button>
              ))}
              <Button onClick={() => onEdit(a)} className="max-md:h-11">
                <Icon name="edit" size={16} />
                {a.status === "reschedule" ? "Remarcar" : "Editar"}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <OpenConversationButton contactId={a.contactId} variant="ghost" size="sm" className="max-md:h-11" />
            <Link href={`/clientes/${a.contactId}`} className={buttonVariants({ variant: "ghost", size: "sm", className: "max-md:h-11" })}>
              <Icon name="contacts" size={16} />
              Ver ficha
            </Link>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
