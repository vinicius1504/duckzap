import "server-only";
import {
  agendaOwnerSchema,
  appointmentSchema,
  appointmentTypeSchema,
  calendarSyncSchema,
  reminderSettingsSchema,
  type AgendaOwner,
  type Appointment,
  type AppointmentRangeQuery,
  type AppointmentStatus,
  type AppointmentType,
  type CalendarSync,
  type ReminderSettings,
  appointmentInputSchema,
  appointmentTypeInputSchema,
  conflictQuerySchema,
} from "@duckzap/contracts/appointments";
import { z } from "zod";
import { get, readOrThrow, send, toResult, type ApiCall, type CommonError } from "@/lib/api-result";
import { type Result } from "@/lib/mock";

// Ligado ao back (apps/api · modules/appointments). Dia e hora seguem no fuso da empresa; quem converte para UTC é o
// servidor. Assinaturas mantidas; erros de rede/permissão chegam como `Result` falho ("unavailable" / "forbidden").
// Rotas: GET /v1/appointments?from&to · /appointments/conflicts · /appointments/contact/:id · /appointments/:id ·
// POST /appointments · PATCH /appointments/:id · POST /appointments/:id/status · /appointment-types ·
// /agenda/{owners,reminder-settings,calendar-sync}.

export type AppointmentInputData = z.output<typeof appointmentInputSchema>;
export type ConflictQueryData = z.output<typeof conflictQuerySchema>;
export type AppointmentTypeInputData = z.output<typeof appointmentTypeInputSchema>;

export type SaveAppointmentResult =
  | { ok: true; data: Appointment }
  | { ok: false; error: "conflict"; message: string; conflicts: Appointment[] }
  | { ok: false; error: "not_found" | "invalid" | CommonError; message: string; conflicts?: undefined };

const enc = encodeURIComponent;
const appointmentsSchema = z.array(appointmentSchema);
const conflictBodySchema = z.object({ error: z.object({ conflicts: appointmentsSchema }) });

// Agendamentos ------------------------------------------------------------------------------------

export async function listAppointments(query: AppointmentRangeQuery): Promise<Appointment[]> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  if (query.ownerId) params.set("ownerId", query.ownerId);
  if (query.typeId) params.set("typeId", query.typeId);
  return readOrThrow(await get(`/v1/appointments?${params}`), appointmentsSchema);
}

export async function listAppointmentsForContact(contactId: string): Promise<Appointment[]> {
  return readOrThrow(await get(`/v1/appointments/contact/${enc(contactId)}`), appointmentsSchema);
}

export async function getAppointment(id: string): Promise<Appointment | null> {
  const call = await get(`/v1/appointments/${enc(id)}`);
  if (!call.ok && call.status === 404) return null;
  return readOrThrow(call, appointmentSchema);
}

/** Agendamentos do mesmo responsável que se sobrepõem ao horário. */
export async function findAppointmentConflicts(query: ConflictQueryData): Promise<Appointment[]> {
  const params = new URLSearchParams({ ownerId: query.ownerId, date: query.date, time: query.time, durationMinutes: String(query.durationMinutes) });
  if (query.excludeId) params.set("excludeId", query.excludeId);
  const call = await get(`/v1/appointments/conflicts?${params}`);
  // a checagem é só um aviso: se falhar, a tela segue (o servidor confere de novo ao salvar)
  return call.ok ? appointmentsSchema.parse(call.json) : [];
}

/** O servidor decide conflito, permissão e referências; em conflito devolve a lista que bate. */
async function save(call: ApiCall): Promise<SaveAppointmentResult> {
  if (call.ok) return { ok: true, data: appointmentSchema.parse(call.json) };
  if (call.code === "conflict") {
    const body = conflictBodySchema.safeParse(call.body);
    return { ok: false, error: "conflict", message: call.message, conflicts: body.success ? body.data.error.conflicts : [] };
  }
  if (call.code === "not_found" || call.code === "invalid") return { ok: false, error: call.code, message: call.message };
  if (call.status === 403) return { ok: false, error: "forbidden", message: call.message };
  if (call.code === "validation_error") return { ok: false, error: "validation_error", message: call.message };
  return { ok: false, error: "unavailable", message: call.message };
}

/** O contato vem do formulário (id); nome e telefone são lidos do cadastro pelo servidor. */
export async function createAppointment(
  input: AppointmentInputData,
  _contact: { id: string; name: string; phone: string | null },
  _createdBy: string,
): Promise<SaveAppointmentResult> {
  return save(await send("POST", "/v1/appointments", input));
}

export async function updateAppointment(
  id: string,
  input: AppointmentInputData,
  _contact: { id: string; name: string; phone: string | null },
): Promise<SaveAppointmentResult> {
  return save(await send("PATCH", `/v1/appointments/${enc(id)}`, input));
}

export async function setAppointmentStatus(
  id: string,
  status: AppointmentStatus,
): Promise<Result<Appointment, "not_found" | "invalid_transition" | "conflict" | CommonError>> {
  return toResult(await send("POST", `/v1/appointments/${enc(id)}/status`, { status }), appointmentSchema, ["not_found", "invalid_transition", "conflict"] as const);
}

// Tipos e responsáveis ----------------------------------------------------------------------------

export async function listAppointmentTypes(): Promise<AppointmentType[]> {
  return readOrThrow(await get("/v1/appointment-types"), z.array(appointmentTypeSchema));
}

export async function createAppointmentType(input: AppointmentTypeInputData): Promise<Result<AppointmentType, "duplicate" | CommonError>> {
  return toResult(await send("POST", "/v1/appointment-types", input), appointmentTypeSchema, ["duplicate"] as const);
}

export async function setAppointmentTypeActive(id: string, active: boolean): Promise<Result<AppointmentType, "not_found" | CommonError>> {
  return toResult(await send("PATCH", `/v1/appointment-types/${enc(id)}`, { active }), appointmentTypeSchema, ["not_found"] as const);
}

/** "Só a equipe marca": a IA não oferece nem agenda este tipo. */
export async function setAppointmentTypeStaffOnly(id: string, staffOnly: boolean): Promise<Result<AppointmentType, "not_found" | CommonError>> {
  return toResult(await send("PATCH", `/v1/appointment-types/${enc(id)}`, { staffOnly }), appointmentTypeSchema, ["not_found"] as const);
}

export async function listAgendaOwners(): Promise<AgendaOwner[]> {
  return readOrThrow(await get("/v1/agenda/owners"), z.array(agendaOwnerSchema));
}

// Google Calendar (estado; o OAuth real vem depois) -----------------------------------------------

export async function getCalendarSync(): Promise<CalendarSync> {
  return readOrThrow(await get("/v1/agenda/calendar-sync"), calendarSyncSchema);
}

export async function syncCalendarNow(): Promise<Result<CalendarSync, "disconnected" | CommonError>> {
  return toResult(await send("POST", "/v1/agenda/calendar-sync/sync"), calendarSyncSchema, ["disconnected"] as const);
}

export async function setCalendarConnected(connected: boolean): Promise<Result<CalendarSync, CommonError>> {
  return toResult(await send("PUT", "/v1/agenda/calendar-sync/connection", { connected }), calendarSyncSchema, [] as const);
}

// Lembretes ---------------------------------------------------------------------------------------

export async function getReminderSettings(): Promise<ReminderSettings> {
  return readOrThrow(await get("/v1/agenda/reminder-settings"), reminderSettingsSchema);
}

export async function updateReminderSettings(settings: ReminderSettings): Promise<Result<ReminderSettings, "invalid" | CommonError>> {
  return toResult(await send("PUT", "/v1/agenda/reminder-settings", settings), reminderSettingsSchema, ["invalid"] as const);
}
