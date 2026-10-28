"use client";

import type { AgendaOwner, Appointment, AppointmentInput, AppointmentType, ReminderSettings } from "@duckzap/contracts/appointments";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Checkbox, Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { checkConflictsAction, saveAppointmentAction } from "../actions";
import { statusView } from "../labels";
import { zonedDay, zonedTime } from "../time";

export type ContactOption = { id: string; name: string; phone: string | null };

type Draft = Omit<AppointmentInput, "allowConflict">;

function initialDraft(
  appointment: Appointment | null,
  defaults: { contactId: string | null; date: string; ownerId: string | null },
  types: AppointmentType[],
  timeZone: string,
): Draft {
  if (appointment) {
    return {
      contactId: appointment.contactId,
      typeId: appointment.typeId,
      ownerId: appointment.ownerId,
      date: zonedDay(appointment.startsAt, timeZone),
      time: zonedTime(appointment.startsAt, timeZone),
      durationMinutes: Math.round((Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) / 60000),
      notes: appointment.notes ?? "",
    };
  }
  const type = types.find((t) => t.active);
  return {
    contactId: defaults.contactId ?? "",
    typeId: type?.id ?? "",
    ownerId: defaults.ownerId ?? "",
    date: defaults.date,
    time: "09:00",
    durationMinutes: type?.durationMinutes ?? 30,
    notes: "",
  };
}

/** Novo / editar agendamento, com aviso de conflito (mesmo responsável, horário sobreposto). */
export function AppointmentFormDialog({
  open,
  onOpenChange,
  appointment,
  defaults,
  contacts,
  types,
  owners,
  reminders,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment: Appointment | null;
  defaults: { contactId: string | null; date: string; ownerId: string | null };
  contacts: ContactOption[];
  types: AppointmentType[];
  owners: AgendaOwner[];
  reminders: ReminderSettings;
  timeZone: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => initialDraft(appointment, defaults, types, timeZone));
  const [conflicts, setConflicts] = useState<Appointment[]>([]);
  const [checking, setChecking] = useState(false);
  const [allowConflict, setAllowConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setDraft(initialDraft(appointment, defaults, types, timeZone));
      setConflicts([]);
      setAllowConflict(false);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // checa conflito sempre que responsável, dia, hora ou duração mudam
  const { ownerId, date, time, durationMinutes } = draft;
  useEffect(() => {
    if (!open || !ownerId || !date || !time) return;
    let alive = true;
    setChecking(true);
    const id = setTimeout(async () => {
      const result = await checkConflictsAction({ ownerId, date, time, durationMinutes, excludeId: appointment?.id ?? null });
      if (!alive) return;
      setChecking(false);
      setConflicts("error" in result ? [] : result.data);
      setAllowConflict(false);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [open, ownerId, date, time, durationMinutes, appointment?.id]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (conflicts.length && !allowConflict) {
      setError("Há conflito de horário. Escolha outro horário ou marque “Salvar mesmo assim”.");
      return;
    }
    startTransition(async () => {
      const result = await saveAppointmentAction(appointment?.id ?? null, { ...draft, allowConflict });
      if ("error" in result) {
        if ("conflicts" in result) {
          setConflicts(result.conflicts);
          setAllowConflict(false);
        }
        return setError(result.error);
      }
      onOpenChange(false);
      router.refresh();
    });
  }

  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? "Atendimento";
  const ownerName = owners.find((o) => o.id === draft.ownerId)?.name ?? "O responsável";
  const activeReminders = reminders.reminders.filter((r) => r.enabled).map((r) => (r.kind === "24h" ? "24 h" : "2 h"));
  const selectableTypes = types.filter((t) => t.active || t.id === draft.typeId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={appointment ? "Editar agendamento" : "Novo agendamento"}>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div>
            <Label htmlFor="ag-cliente">Cliente</Label>
            <Select id="ag-cliente" value={draft.contactId} onChange={(e) => set("contactId", e.target.value)} required>
              <option value="">Escolha o cliente</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ag-tipo">Tipo de atendimento</Label>
              <Select
                id="ag-tipo"
                value={draft.typeId}
                onChange={(e) => {
                  const type = types.find((t) => t.id === e.target.value);
                  setDraft((d) => ({ ...d, typeId: e.target.value, durationMinutes: type?.durationMinutes ?? d.durationMinutes }));
                }}
                required
              >
                <option value="">Escolha</option>
                {selectableTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.durationMinutes} min
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="ag-duracao">Duração (min)</Label>
              <Input
                id="ag-duracao"
                type="number"
                inputMode="numeric"
                min={5}
                max={480}
                step={5}
                value={draft.durationMinutes}
                onChange={(e) => set("durationMinutes", Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="ag-data">Dia</Label>
              <Input id="ag-data" type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="ag-hora">Hora</Label>
              <Input id="ag-hora" type="time" step={300} value={draft.time} onChange={(e) => set("time", e.target.value)} required />
            </div>
          </div>
          <div>
            <Label htmlFor="ag-resp">Responsável</Label>
            <Select id="ag-resp" value={draft.ownerId} onChange={(e) => set("ownerId", e.target.value)} required>
              <option value="">Escolha quem atende</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>

          <div aria-live="polite">
            {checking ? (
              <p className="flex items-center gap-2 text-[13px] text-ink-2">
                <Spinner size={14} /> Verificando a agenda…
              </p>
            ) : conflicts.length ? (
              <div className="flex flex-col gap-2 rounded-control bg-warn-bg p-3 text-warn">
                <strong>Conflito de horário</strong>
                <ul className="flex flex-col gap-0.5 text-[13px]">
                  {conflicts.map((c) => (
                    <li key={c.id}>
                      {ownerName} já tem {typeName(c.typeId)} com {c.contactName} das {zonedTime(c.startsAt, timeZone)} às{" "}
                      {zonedTime(c.endsAt, timeZone)} ({statusView[c.status].label.toLowerCase()}).
                    </li>
                  ))}
                </ul>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 font-semibold">
                  <Checkbox checked={allowConflict} onChange={(e) => setAllowConflict(e.target.checked)} />
                  Salvar mesmo assim
                </label>
              </div>
            ) : draft.ownerId && draft.date && draft.time ? (
              <p className="text-[13px] font-semibold text-ok">Horário livre para {ownerName}.</p>
            ) : null}
          </div>

          <div>
            <Label htmlFor="ag-obs">Observações (opcional)</Label>
            <Textarea id="ag-obs" rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} />
          </div>

          <p className="text-[13px] text-ink-2">
            {activeReminders.length
              ? `Lembretes automáticos pelo WhatsApp ${activeReminders.join(" e ")} antes. ${
                  reminders.confirmByReply ? "O cliente confirma respondendo 1 ou SIM." : ""
                }`
              : "Lembretes automáticos desligados."}
            {appointment && appointment.status !== "pending" ? " Mudar o horário volta o status para Pendente." : ""}
          </p>

          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Salvando…" : appointment ? "Salvar" : "Agendar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
