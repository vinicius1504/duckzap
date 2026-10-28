"use client";

import type { InboxLookups } from "@duckzap/contracts/conversations";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { Spinner } from "@duckzap/ui/components/feedback";
import { useState, useTransition, type FormEvent } from "react";
import { scheduleAppointmentAction } from "../actions";
import { addDays, dateInZone, zonedIso } from "./view-model";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactName: string;
  lookups: InboxLookups;
  nowIso: string;
  timeZone: string;
};

/** Agendamento rápido a partir da conversa. A agenda completa (conflitos, lembretes) fica no módulo Agenda. */
export function AppointmentDialog({ open, onOpenChange, conversationId, contactName, lookups, nowIso, timeZone }: Props) {
  const today = dateInZone(nowIso, timeZone);
  const [typeId, setTypeId] = useState(lookups.appointmentTypes[0]?.id ?? "");
  const [date, setDate] = useState(addDays(today, 1));
  const [time, setTime] = useState("09:00");
  const [professional, setProfessional] = useState(lookups.professionals[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const type = lookups.appointmentTypes.find((t) => t.id === typeId);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!date || !time) {
      setError("Escolha o dia e o horário.");
      return;
    }
    startTransition(async () => {
      const result = await scheduleAppointmentAction({
        conversationId,
        appointmentTypeId: typeId,
        startsAt: zonedIso(date, time, timeZone),
        professional,
      });
      if (result) setError(result.error);
      else onOpenChange(false);
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
      <DialogContent title="Agendar atendimento" description={`Para ${contactName}. Fica como pendente até a confirmação.`} size="sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="apt-type">Tipo de atendimento</Label>
            <Select id="apt-type" className="h-11" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {lookups.appointmentTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.durationMinutes} min
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3 max-[400px]:grid-cols-1">
            <div>
              <Label htmlFor="apt-date">Dia</Label>
              <Input id="apt-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="apt-time">Horário</Label>
              <Input id="apt-time" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} required />
            </div>
          </div>
          <div>
            <Label htmlFor="apt-pro">Profissional</Label>
            <Select id="apt-pro" className="h-11" value={professional} onChange={(e) => setProfessional(e.target.value)}>
              {lookups.professionals.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          {type ? <p className="text-[13px] text-ink-2">Duração: {type.durationMinutes} min. O lembrete sai 24 h e 2 h antes.</p> : null}
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
              Agendar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
