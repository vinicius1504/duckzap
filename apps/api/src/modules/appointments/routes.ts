import {
  appointmentInputSchema,
  appointmentRangeQuerySchema,
  appointmentStatusSchema,
  appointmentTypeInputSchema,
  conflictQuerySchema,
  reminderSettingsSchema,
} from "@duckzap/contracts/appointments";
import type { Transaction } from "@duckzap/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { AppBindings, Deps } from "../../lib/context";
import { withOrgRealtime } from "../../lib/realtime";
import {
  ApiError,
  failToError,
  idParam,
  jsonLimit,
  moduleErrorHandler,
  parseWith,
  permit,
  readJson,
  requestCtx,
  tenantGuard,
  unwrap,
  type ModuleContext,
} from "../contacts/http";
import { createNoopCalendarPort, type AppointmentsPorts } from "./ports";
import * as service from "./service";
import { shiftDay } from "./time";

// Ids que o contrato declara como texto: na API contato e tipo são UUID (malformado seria erro de SQL, 500)
const appointmentBodySchema = appointmentInputSchema.extend({
  contactId: z.guid({ error: "Escolha o cliente." }),
  typeId: z.guid({ error: "Escolha o tipo de atendimento." }),
  ownerId: z.string().min(1, "Escolha o responsável.").max(100),
});
const statusBody = z.object({ status: appointmentStatusSchema });
const typePatchBody = z.object({ active: z.boolean().optional(), staffOnly: z.boolean().optional() });
const connectionBody = z.object({ connected: z.boolean() });

const rangeSchema = appointmentRangeQuerySchema
  .extend({ ownerId: z.string().min(1).max(100).optional(), typeId: z.guid().optional() })
  .refine((q) => q.to >= q.from, { message: "O fim do período vem antes do início.", path: ["to"] })
  .refine((q) => q.to <= shiftDay(q.from, service.MAX_RANGE_DAYS), {
    message: `O período pode ter no máximo ${service.MAX_RANGE_DAYS} dias.`,
    path: ["to"],
  });

const conflictQuery = z.object({
  ownerId: z.string().min(1).max(100),
  date: z.iso.date(),
  time: z.string(),
  durationMinutes: z.coerce.number(),
  excludeId: z.guid().optional(),
});

/** Em conflito, devolve também os agendamentos que batem (a tela mostra o aviso). */
function saveFailure(result: Extract<service.SaveResult, { ok: false }>) {
  return failToError(result, result.conflicts ? { conflicts: result.conflicts } : {});
}

export function appointmentsRoutes(deps: Deps, ports: AppointmentsPorts = { calendar: createNoopCalendarPort() }) {
  const app = new OpenAPIHono<AppBindings>();
  app.onError(moduleErrorHandler);
  const guard = tenantGuard(deps);
  const run = <T>(c: ModuleContext, fn: (tx: Transaction) => Promise<T>) => withOrgRealtime(deps.db, requestCtx(c).organizationId, fn);

  // Leitura: qualquer pessoa da equipe ----------------------------------------------------------------------------
  app.get("/appointments", guard, async (c) => {
    const query = parseWith(rangeSchema, c.req.query());
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listAppointments(tx, ctx, query)));
  });

  app.get("/appointments/conflicts", guard, permit("appointment.manage"), async (c) => {
    const raw = parseWith(conflictQuery, c.req.query());
    const query = parseWith(conflictQuerySchema, { ...raw, excludeId: raw.excludeId ?? null });
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.findAppointmentConflicts(tx, ctx, query)));
  });

  app.get("/appointments/contact/:contactId", guard, async (c) => {
    const contactId = idParam(c, "contactId");
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listAppointmentsForContact(tx, ctx, contactId)));
  });

  app.get("/appointments/:id", guard, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const found = await run(c, (tx) => service.getAppointment(tx, ctx, id));
    if (!found) throw new ApiError(404, "not_found", "Agendamento não encontrado.");
    return c.json(found);
  });

  // Agendamentos --------------------------------------------------------------------------------------------------
  app.post("/appointments", guard, permit("appointment.manage"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, appointmentBodySchema);
    const result = await run(c, (tx) => service.createAppointment(tx, ctx, body));
    if (!result.ok) throw saveFailure(result);
    return c.json(result.data, 201);
  });

  app.patch("/appointments/:id", guard, permit("appointment.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const body = await readJson(c, appointmentBodySchema);
    const result = await run(c, (tx) => service.updateAppointment(tx, ctx, id, body));
    if (!result.ok) throw saveFailure(result);
    return c.json(result.data);
  });

  app.post("/appointments/:id/status", guard, permit("appointment.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const body = await readJson(c, statusBody);
    return c.json(unwrap(await run(c, (tx) => service.setAppointmentStatus(tx, ctx, id, body.status))));
  });

  // Tipos de atendimento: configuração (settings.manage, como o front) -------------------------------------------------
  app.get("/appointment-types", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listAppointmentTypes(tx, ctx)));
  });

  app.post("/appointment-types", guard, permit("settings.manage"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, appointmentTypeInputSchema);
    return c.json(unwrap(await run(c, (tx) => service.createAppointmentType(tx, ctx, body))), 201);
  });

  app.patch("/appointment-types/:id", guard, permit("settings.manage"), jsonLimit, async (c) => {
    const id = idParam(c);
    const ctx = requestCtx(c);
    const body = await readJson(c, typePatchBody);
    return c.json(unwrap(await run(c, (tx) => service.updateAppointmentType(tx, ctx, id, body))));
  });

  app.get("/agenda/owners", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.listAgendaOwners(tx, ctx)));
  });

  // Lembretes ------------------------------------------------------------------------------------------------------
  app.get("/agenda/reminder-settings", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.getReminderSettings(tx, ctx)));
  });

  app.put("/agenda/reminder-settings", guard, permit("settings.manage"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, reminderSettingsSchema);
    return c.json(unwrap(await run(c, (tx) => service.updateReminderSettings(tx, ctx, body))));
  });

  // Google Calendar (estado; sem OAuth nesta fase) ---------------------------------------------------------------
  app.get("/agenda/calendar-sync", guard, async (c) => {
    const ctx = requestCtx(c);
    return c.json(await run(c, (tx) => service.getCalendarSync(tx, ctx)));
  });

  app.post("/agenda/calendar-sync/sync", guard, permit("appointment.manage"), async (c) => {
    const ctx = requestCtx(c);
    return c.json(unwrap(await service.syncCalendarNow(deps.db, ctx, ports.calendar)));
  });

  app.put("/agenda/calendar-sync/connection", guard, permit("integration.manage"), jsonLimit, async (c) => {
    const ctx = requestCtx(c);
    const body = await readJson(c, connectionBody);
    const email = ctx.session.user.email;
    return c.json(await run(c, (tx) => service.setCalendarConnected(tx, ctx, body.connected, email)));
  });

  return app;
}
