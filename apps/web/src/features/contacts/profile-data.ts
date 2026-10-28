import "server-only";
import { listAgendaOwners, listAppointmentTypes, listAppointmentsForContact } from "@/features/appointments/api";
import type { ProfileAppointment } from "./components/contact-profile";

/** Agendamentos do cliente já no formato da ficha (junta tipos e responsáveis da Agenda). */
export async function loadProfileAppointments(contactId: string): Promise<ProfileAppointment[]> {
  const [appointments, types, owners] = await Promise.all([
    listAppointmentsForContact(contactId),
    listAppointmentTypes(),
    listAgendaOwners(),
  ]);
  return appointments.map((a) => {
    const type = types.find((t) => t.id === a.typeId);
    return {
      id: a.id,
      startsAt: a.startsAt,
      status: a.status,
      typeName: type?.name ?? "Atendimento",
      durationMinutes: Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000),
      ownerName: owners.find((o) => o.id === a.ownerId)?.name ?? "—",
    };
  });
}
