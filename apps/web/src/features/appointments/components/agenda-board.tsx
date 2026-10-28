"use client";

import {
  findConflicts,
  type AgendaOwner,
  type Appointment,
  type AppointmentStatus,
  type AppointmentType,
  type ReminderSettings,
} from "@duckzap/contracts/appointments";
import { Button } from "@duckzap/ui/components/button";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Select } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Segmented } from "@duckzap/ui/components/segmented";
import { cn } from "@duckzap/ui/cn";
import { addMonths } from "date-fns";
import { useQueryStates } from "nuqs";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { setStatusAction } from "../actions";
import { agendaParsers, type AgendaPerms } from "../search-params";
import { dateToDay, dayToDate, formatDay, LIST_DAYS, shiftDay, shortTime, zonedDay, type AgendaView } from "../time";
import { AppointmentDetailsDialog } from "./appointment-details-dialog";
import { AppointmentFormDialog, type ContactOption } from "./appointment-form-dialog";
import { ListView, MonthView, WeekView } from "./views";

const viewOptions = [
  { value: "mes", label: "Mês" },
  { value: "semana", label: "Semana" },
  { value: "lista", label: "Lista" },
] as const satisfies readonly { value: AgendaView; label: string }[];

function periodLabel(view: AgendaView, from: string, to: string, anchor: string) {
  if (view === "mes") {
    const text = formatDay(anchor, { month: "long", year: "numeric" });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  const start = formatDay(from, sameMonth ? { day: "numeric" } : { day: "numeric", month: "long" });
  return `${start} – ${formatDay(to, { day: "numeric", month: "long" })}`;
}

export function AgendaBoard({
  appointments,
  types,
  owners,
  contacts,
  reminders,
  view,
  anchor,
  from,
  to,
  today,
  nowIso,
  timeZone,
  ownerFilter,
  typeFilter,
  perms,
  newFor,
}: {
  appointments: Appointment[];
  types: AppointmentType[];
  owners: AgendaOwner[];
  contacts: ContactOption[];
  reminders: ReminderSettings;
  view: AgendaView;
  anchor: string;
  from: string;
  to: string;
  today: string;
  nowIso: string;
  timeZone: string;
  ownerFilter: string | undefined;
  typeFilter: string | undefined;
  perms: AgendaPerms;
  newFor: { contactId: string | null } | null;
}) {
  const router = useRouter();
  const [navPending, startNav] = useTransition();
  const [, setParams] = useQueryStates(agendaParsers, { shallow: false, startTransition: startNav });
  const [optimistic, setOptimisticStatus] = useOptimistic(appointments, (state, change: { id: string; status: AppointmentStatus }) =>
    state.map((a) => (a.id === change.id ? { ...a, status: change.status } : a)),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<{ appointment: Appointment | null; contactId: string | null } | null>(
    newFor && perms.manage ? { appointment: null, contactId: newFor.contactId } : null,
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusPending, startStatus] = useTransition();

  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? "Atendimento";
  const ownerName = (id: string) => owners.find((o) => o.id === id)?.name ?? "—";
  const conflictIds = findConflicts(optimistic);
  const opened = optimistic.find((a) => a.id === openId) ?? null;

  // aviso de conflito: o primeiro par do período
  const firstConflict = (() => {
    const list = optimistic.filter((a) => conflictIds.has(a.id)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const a = list[0];
    if (!a) return null;
    const b = list.find((x) => x.id !== a.id && x.ownerId === a.ownerId && zonedDay(x.startsAt, timeZone) === zonedDay(a.startsAt, timeZone));
    if (!b) return null;
    const weekday = formatDay(zonedDay(a.startsAt, timeZone), { weekday: "long" }).replace("-feira", "");
    return { text: `${ownerName(a.ownerId)} tem dois agendamentos na ${weekday}, às ${shortTime(a.startsAt, timeZone)} e às ${shortTime(b.startsAt, timeZone)}.`, id: a.id, count: conflictIds.size };
  })();

  function changeStatus(id: string, status: AppointmentStatus) {
    startStatus(async () => {
      setOptimisticStatus({ id, status });
      const result = await setStatusAction(id, status);
      setStatusError("error" in result ? result.error : null);
      router.refresh();
    });
  }

  function step(direction: -1 | 1) {
    const next =
      view === "mes"
        ? dateToDay(addMonths(dayToDate(anchor), direction))
        : shiftDay(anchor, direction * (view === "semana" ? 7 : LIST_DAYS));
    void setParams({ data: next });
  }

  function closeForm(open: boolean) {
    if (open) return;
    setForm(null);
    if (newFor) void setParams({ novo: null, cliente: null });
  }

  const viewProps = {
    appointments: optimistic,
    from,
    to,
    today,
    nowIso,
    timeZone,
    conflictIds,
    typeName,
    ownerName,
    onOpen: setOpenId,
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-1 text-[28px] font-extrabold tracking-[-0.02em] max-md:text-2xl">Agenda</h1>
          <Button size="sm" onClick={() => void setParams({ data: null })} className="max-md:h-11">
            Hoje
          </Button>
          <Button size="icon" variant="secondary" className="size-8 max-md:size-11" aria-label="Período anterior" onClick={() => step(-1)}>
            <Icon name="chevronLeft" size={16} strokeWidth={2} />
          </Button>
          <Button size="icon" variant="secondary" className="size-8 max-md:size-11" aria-label="Próximo período" onClick={() => step(1)}>
            <Icon name="chevronRight" size={16} strokeWidth={2} />
          </Button>
          <strong className="text-base" aria-live="polite">
            {periodLabel(view, from, to, anchor)}
          </strong>
          {navPending ? (
            <span role="status" aria-label="Carregando" className="text-ink-2">
              <Spinner size={16} />
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Segmented label="Visão" options={viewOptions} value={view} onChange={(v) => void setParams({ visao: v === "semana" ? null : v })} />
          <div>
            <label htmlFor="ag-f-resp" className="sr-only">
              Responsável
            </label>
            <Select
              id="ag-f-resp"
              value={ownerFilter ?? ""}
              onChange={(e) => void setParams({ responsavel: e.target.value || null })}
              className="w-auto max-md:h-11"
            >
              <option value="">Responsável: Todos</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="ag-f-tipo" className="sr-only">
              Tipo
            </label>
            <Select
              id="ag-f-tipo"
              value={typeFilter ?? ""}
              onChange={(e) => void setParams({ tipo: e.target.value || null })}
              className="w-auto max-md:h-11"
            >
              <option value="">Tipo: Todos</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="primary"
            onClick={() => setForm({ appointment: null, contactId: null })}
            disabled={!perms.manage}
            title={perms.manage ? undefined : "Seu papel não permite. Fale com um administrador."}
            className="max-md:h-11"
          >
            <Icon name="plus" size={16} />
            Novo agendamento
          </Button>
        </div>
      </div>

      {firstConflict ? (
        <Alert
          tone="warn"
          title="Conflito de horário:"
          action={
            <Button size="sm" onClick={() => setOpenId(firstConflict.id)}>
              Ver
            </Button>
          }
        >
          {firstConflict.text}
          {firstConflict.count > 2 ? ` Há ${firstConflict.count} agendamentos em conflito neste período.` : ""}
        </Alert>
      ) : null}
      {statusError ? (
        <Alert tone="err" live>
          {statusError}
        </Alert>
      ) : null}

      <div className={cn(navPending && "opacity-70 transition-opacity")}>
        {view === "semana" ? <WeekView {...viewProps} /> : null}
        {view === "mes" ? (
          <MonthView {...viewProps} month={anchor.slice(0, 7)} onPickDay={(day) => void setParams({ visao: null, data: day })} />
        ) : null}
        {view === "lista" ? <ListView {...viewProps} canManage={perms.manage} onConfirm={(id) => changeStatus(id, "confirmed")} /> : null}
      </div>
      {optimistic.length === 0 && view !== "lista" ? (
        <p className="text-center text-ink-2">Nenhum agendamento neste período{ownerFilter || typeFilter ? " com esses filtros" : ""}.</p>
      ) : null}

      <AppointmentDetailsDialog
        appointment={opened}
        onOpenChange={(open) => (open ? undefined : setOpenId(null))}
        typeName={typeName}
        ownerName={ownerName}
        conflict={opened ? conflictIds.has(opened.id) : false}
        timeZone={timeZone}
        canManage={perms.manage}
        pending={statusPending}
        error={statusError}
        onStatus={changeStatus}
        onEdit={(appointment) => {
          setOpenId(null);
          setForm({ appointment, contactId: appointment.contactId });
        }}
      />
      {perms.manage ? (
        <AppointmentFormDialog
          key={form?.appointment?.id ?? "new"}
          open={form !== null}
          onOpenChange={closeForm}
          appointment={form?.appointment ?? null}
          defaults={{ contactId: form?.contactId ?? null, date: anchor < today ? today : anchor, ownerId: ownerFilter ?? null }}
          contacts={contacts}
          types={types}
          owners={owners}
          reminders={reminders}
          timeZone={timeZone}
        />
      ) : null}
    </div>
  );
}
