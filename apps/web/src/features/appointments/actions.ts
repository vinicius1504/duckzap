"use server";

import {
  appointmentInputSchema,
  appointmentStatusSchema,
  appointmentTypeInputSchema,
  conflictQuerySchema,
  reminderSettingsSchema,
  type Appointment,
  type AppointmentInput,
  type AppointmentStatus,
  type AppointmentTypeInput,
  type ConflictQuery,
  type ReminderSettings,
} from "@duckzap/contracts/appointments";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/features/auth/permissions";
import { listContactOptions } from "@/features/contacts/api";
import * as api from "./api";

// Server Actions finas: permissão → validação → api.ts → revalidar.

export type ActionResult<T = null> = { ok: true; data: T } | { error: string };
export type SaveResult = ActionResult<{ id: string }> | { error: string; conflicts: Appointment[] };

const PATH = "/agenda";

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Confira os campos.";
}

export async function checkConflictsAction(query: ConflictQuery): Promise<ActionResult<Appointment[]>> {
  const auth = await authorize("appointment.manage");
  if ("error" in auth) return auth;
  const parsed = conflictQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: true, data: [] };
  return { ok: true, data: await api.findAppointmentConflicts(parsed.data) };
}

export async function saveAppointmentAction(id: string | null, input: AppointmentInput): Promise<SaveResult> {
  const auth = await authorize("appointment.manage");
  if ("error" in auth) return auth;
  const parsed = appointmentInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const contact = (await listContactOptions()).find((c) => c.id === parsed.data.contactId);
  if (!contact) return { error: "Cliente não encontrado." };
  const result = id
    ? await api.updateAppointment(id, parsed.data, contact)
    : await api.createAppointment(parsed.data, contact, auth.session.user.name);
  if (!result.ok) return result.error === "conflict" ? { error: result.message, conflicts: result.conflicts } : { error: result.message };
  revalidatePath(PATH);
  revalidatePath("/clientes", "layout");
  return { ok: true, data: { id: result.data.id } };
}

export async function setStatusAction(id: string, status: AppointmentStatus): Promise<ActionResult> {
  const auth = await authorize("appointment.manage");
  if ("error" in auth) return auth;
  const result = await api.setAppointmentStatus(z.string().parse(id), appointmentStatusSchema.parse(status));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  revalidatePath("/clientes", "layout");
  return { ok: true, data: null };
}

// Tipos de atendimento e lembretes são configuração da agenda: a matriz não tem permissão própria,
// então usam settings.manage (admin/proprietário).

export async function createTypeAction(input: AppointmentTypeInput): Promise<ActionResult> {
  const auth = await authorize("settings.manage");
  if ("error" in auth) return auth;
  const parsed = appointmentTypeInputSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.createAppointmentType(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function setTypeActiveAction(id: string, active: boolean): Promise<ActionResult> {
  const auth = await authorize("settings.manage");
  if ("error" in auth) return auth;
  const result = await api.setAppointmentTypeActive(z.string().parse(id), z.boolean().parse(active));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function setTypeStaffOnlyAction(id: string, staffOnly: boolean): Promise<ActionResult> {
  const auth = await authorize("settings.manage");
  if ("error" in auth) return auth;
  const result = await api.setAppointmentTypeStaffOnly(z.string().parse(id), z.boolean().parse(staffOnly));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function saveRemindersAction(settings: ReminderSettings): Promise<ActionResult> {
  const auth = await authorize("settings.manage");
  if ("error" in auth) return auth;
  const parsed = reminderSettingsSchema.safeParse(settings);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await api.updateReminderSettings(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function syncCalendarAction(): Promise<ActionResult> {
  const auth = await authorize("appointment.manage");
  if ("error" in auth) return auth;
  const result = await api.syncCalendarNow();
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function setCalendarConnectedAction(connected: boolean): Promise<ActionResult> {
  const auth = await authorize("integration.manage");
  if ("error" in auth) return auth;
  const result = await api.setCalendarConnected(z.boolean().parse(connected));
  if (!result.ok) return { error: result.message };
  revalidatePath(PATH);
  return { ok: true, data: null };
}
