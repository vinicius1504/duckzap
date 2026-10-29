import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import {
  getCalendarSync,
  getReminderSettings,
  listAgendaOwners,
  listAppointmentTypes,
  listAppointments,
} from "@/features/appointments/api";
import { AgendaBoard } from "@/features/appointments/components/agenda-board";
import { GOOGLE_CALENDAR_ENABLED } from "@/lib/features";
import { GoogleSyncCard, RemindersCard, TypesCard } from "@/features/appointments/components/agenda-sidebar";
import { agendaPerms, parseAgendaSearch } from "@/features/appointments/search-params";
import { rangeFor, todayIn } from "@/features/appointments/time";
import { requireSession } from "@/features/auth/session";
import { listContactOptions } from "@/features/contacts/api";

export const metadata: Metadata = { title: "Agenda" };

export default async function AgendaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const timeZone = session.organization.timeZone;
  const today = todayIn(timeZone);
  const { view, anchor, ownerId, typeId, newFor } = parseAgendaSearch(await searchParams, today);
  const { from, to } = rangeFor(view, anchor);
  const perms = agendaPerms(session.user.role);

  const [appointments, types, owners, contacts, sync, reminders] = await Promise.all([
    listAppointments({ from, to, ownerId, typeId }),
    listAppointmentTypes(),
    listAgendaOwners(),
    listContactOptions(),
    getCalendarSync(),
    getReminderSettings(),
  ]);
  const nowIso = new Date().toISOString();

  return (
    <Page className="gap-[18px]">
      <div className="flex flex-wrap items-start gap-5 lg:items-stretch">
        <section aria-label="Calendário" className="flex min-w-0 flex-[1_1_680px] flex-col">
          <AgendaBoard
            appointments={appointments}
            types={types}
            owners={owners}
            contacts={contacts}
            reminders={reminders}
            view={view}
            anchor={anchor}
            from={from}
            to={to}
            today={today}
            nowIso={nowIso}
            timeZone={timeZone}
            ownerFilter={ownerId}
            typeFilter={typeId}
            perms={perms}
            newFor={newFor}
          />
        </section>
        <aside aria-label="Ajustes da agenda" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 lg:max-w-[340px]">
          {GOOGLE_CALENDAR_ENABLED ? <GoogleSyncCard sync={sync} nowIso={nowIso} perms={perms} /> : null}
          <TypesCard types={types} perms={perms} />
          <RemindersCard settings={reminders} perms={perms} />
        </aside>
      </div>
    </Page>
  );
}
