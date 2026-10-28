import {
  PortError,
  type AgentPorts,
  type AppointmentInfo,
  type AppointmentTypeInfo,
  type ContactInfo,
  type Scope,
  type Slot,
} from "@duckzap/ai";
import { schema, type Database, type Transaction } from "@duckzap/db";
import { and, asc, eq, gte, ne, sql } from "drizzle-orm";
import { createDbKnowledgePort } from "../agents/knowledge-store";
import { queueRealtime } from "../../lib/realtime";
import { createAppointment, setAppointmentStatus, updateAppointment } from "../appointments/service";
import { zonedDay, zonedTime } from "../appointments/time";
import { isGuid } from "../contacts/http";
import type { ServiceCtx } from "../contacts/result";
import { registerOptOut } from "../contacts/service";
import { appointmentNotice } from "../notifications/logic";
import { notifyAppointmentTeam } from "../notifications/service";
import { generateSlots, parseSlotId, slotId } from "./logic";
import { addEvent } from "./outbound";
import { loadTags, type ConversationRow } from "./queries";
import { businessHoursFor } from "./inbound";
import { setFunnelStage } from "./service";

const { conversations, contacts, contactTags, tags, appointments, appointmentTypes, member } = schema;

/**
 * Portas REAIS do runtime de IA (`@duckzap/ai`), em cima dos serviços de Clientes, Agenda e Conversas. Escopo (empresa,
 * conversa, contato, agente) vem do servidor; o modelo nunca escolhe. Rodam na transação do turno (a mesma que segura o lock
 * `conv:{id}`), então um handoff e a mensagem que o acompanha andam juntos.
 */

export type PortsEnv = {
  tx: Transaction;
  db: Database;
  conv: ConversationRow;
  agentName: string;
  ctx: ServiceCtx;
  lastCustomerText: string;
  now: Date;
};

type TypeRow = typeof appointmentTypes.$inferSelect;

async function findType(env: PortsEnv, typeId: string): Promise<TypeRow | null> {
  if (!isGuid(typeId)) return null;
  const [row] = await env.tx
    .select()
    .from(appointmentTypes)
    .where(and(eq(appointmentTypes.organizationId, env.ctx.organizationId), eq(appointmentTypes.id, typeId), eq(appointmentTypes.active, true)))
    .limit(1);
  return row ?? null;
}

/** Quem atende o agendamento da IA: o responsável do cliente, o da conversa ou, na falta, o dono da empresa. */
async function pickOwnerId(env: PortsEnv, contactId: string): Promise<string> {
  const [contact] = await env.tx.select({ ownerId: contacts.ownerId }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
  const candidates = [contact?.ownerId, env.conv.assigneeId].filter((v): v is string => Boolean(v));
  for (const id of candidates) {
    const [m] = await env.tx.select({ id: member.id }).from(member).where(and(eq(member.organizationId, env.ctx.organizationId), eq(member.userId, id))).limit(1);
    if (m) return id;
  }
  const [first] = await env.tx
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, env.ctx.organizationId))
    .orderBy(sql`case ${member.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, asc(member.createdAt))
    .limit(1);
  if (!first) throw new PortError("unavailable", "Nenhum responsável disponível para a agenda.");
  return first.userId;
}

async function freeSlots(env: PortsEnv, type: TypeRow, ownerId: string, fromDay: string, toDay: string): Promise<Date[]> {
  const { hours, timeZone } = await businessHoursFor(env.tx, env.ctx.organizationId, env.conv.teamId);
  const horizonEnd = new Date(env.now.getTime() + 60 * 86_400_000);
  const busyRows = await env.tx
    .select({ start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, env.ctx.organizationId),
        eq(appointments.ownerId, ownerId),
        ne(appointments.status, "canceled"),
        gte(appointments.endsAt, env.now),
        sql`${appointments.startsAt} < ${horizonEnd.toISOString()}::timestamptz`,
      ),
    );
  return generateSlots({ fromDay, toDay, hours, timeZone, durationMinutes: type.durationMinutes, busy: busyRows.map((r) => ({ start: r.start, end: r.end })), now: env.now });
}

const toTypeInfo = (t: TypeRow): AppointmentTypeInfo => ({ id: t.id, name: t.name, durationMinutes: t.durationMinutes, staffOnly: t.staffOnly });

function toInfo(a: { id: string; typeId: string; startsAt: Date; status: string }): AppointmentInfo {
  return {
    id: a.id,
    typeId: a.typeId,
    startsAt: a.startsAt.toISOString(),
    status: a.status === "canceled" ? "canceled" : a.status === "confirmed" || a.status === "done" ? "confirmed" : "pending",
  };
}

/** O contato do escopo é SEMPRE o da conversa em curso; o escopo que o runtime manda é conferido contra ela. */
function assertScope(env: PortsEnv, scope: Scope) {
  if (scope.organizationId !== env.ctx.organizationId || scope.conversationId !== env.conv.id || scope.contactId !== env.conv.contactId) {
    throw new PortError("forbidden", "Escopo inválido.");
  }
}

/**
 * Avisa a equipe (sino) que a IA mexeu na agenda. Roda DEPOIS de gravar, num savepoint: falhar aqui nunca desfaz nem
 * impede o agendamento. Só o modo ao vivo chega aqui (Copiloto e simulador não executam as portas que gravam).
 */
async function notifyAppointment(
  env: PortsEnv,
  kind: "appointment_booked" | "appointment_rescheduled" | "appointment_canceled",
  info: { contactId: string; typeId: string; typeName?: string; startsAt: Date; ownerId: string; pending?: boolean },
) {
  try {
    const [contact] = await env.tx.select({ name: contacts.name, phone: contacts.phone }).from(contacts).where(eq(contacts.id, info.contactId)).limit(1);
    const typeName = info.typeName ?? (await env.tx.select({ name: appointmentTypes.name }).from(appointmentTypes).where(eq(appointmentTypes.id, info.typeId)).limit(1))[0]?.name ?? "Agendamento";
    const { title, body } = appointmentNotice({
      kind,
      agentName: env.agentName,
      clientName: contact?.name?.trim() || contact?.phone || "Cliente",
      typeName,
      startsAt: info.startsAt,
      timeZone: env.ctx.timeZone,
      pending: info.pending,
    });
    await notifyAppointmentTeam(env.tx, env.ctx.organizationId, { teamId: env.conv.teamId, ownerId: info.ownerId, payload: { kind, title, body, link: `/conversas?conversa=${env.conv.id}` } }, env.now);
  } catch (error) {
    // a leitura do contato/tipo também não pode derrubar o agendamento (consultas simples; não abortam a transação)
    console.warn("notifications: falha ao montar o aviso do agendamento", { error: error instanceof Error ? error.name : "unknown" });
  }
}

export function createRealPorts(env: PortsEnv): AgentPorts {
  const knowledge = createDbKnowledgePort(env.db);
  const org = env.ctx.organizationId;
  const sourceName = env.agentName;

  return {
    knowledge: {
      search: async (scope, query, limit) => {
        assertScope(env, scope);
        return knowledge.search(scope, query, limit);
      },
    },

    agenda: {
      async getType(scope, typeId) {
        assertScope(env, scope);
        const t = await findType(env, typeId);
        return t ? toTypeInfo(t) : null;
      },

      async listAvailableSlots(scope, query) {
        assertScope(env, scope);
        const type = await findType(env, query.typeId);
        if (!type) throw new PortError("not_found", "Tipo de atendimento não encontrado.");
        const owner = await pickOwnerId(env, scope.contactId);
        const slots = await freeSlots(env, type, owner, query.from, query.to);
        return slots.map((s): Slot => ({ id: slotId(type.id, s), typeId: type.id, startsAt: s.toISOString() }));
      },

      async listContactAppointments(scope) {
        assertScope(env, scope);
        const rows = await env.tx
          .select({ id: appointments.id, typeId: appointments.typeId, startsAt: appointments.startsAt, status: appointments.status })
          .from(appointments)
          .where(and(eq(appointments.organizationId, org), eq(appointments.contactId, scope.contactId), ne(appointments.status, "canceled"), gte(appointments.startsAt, env.now)))
          .orderBy(asc(appointments.startsAt))
          .limit(10);
        return rows.map(toInfo);
      },

      async bookAppointment(scope, input) {
        assertScope(env, scope);
        const type = await findType(env, input.typeId);
        if (!type) throw new PortError("not_found", "Tipo de atendimento não encontrado.");
        const at = parseSlotId(input.slotId, type.id);
        if (!at) throw new PortError("invalid", "Horário inválido. Liste os horários livres de novo.");
        const owner = await pickOwnerId(env, scope.contactId);
        // só vale um horário que a própria agenda ofereceria (o modelo não inventa horário)
        const day = zonedDay(at.toISOString(), env.ctx.timeZone);
        const offered = await freeSlots(env, type, owner, day, day);
        if (!offered.some((s) => s.getTime() === at.getTime())) throw new PortError("conflict", "Esse horário não está mais livre. Liste os horários de novo.");
        const created = await createAppointment(
          env.tx,
          env.ctx,
          {
            contactId: scope.contactId,
            typeId: type.id,
            ownerId: owner,
            date: day,
            time: zonedTime(at.toISOString(), env.ctx.timeZone),
            durationMinutes: type.durationMinutes,
            notes: "Marcado pela IA",
            allowConflict: false,
          },
          { source: "ai_agent", sourceName },
          env.now,
        );
        if (!created.ok) throw new PortError(created.error === "conflict" ? "conflict" : "invalid", created.error === "conflict" ? "Esse horário acabou de ser ocupado. Liste os horários de novo." : created.message);
        // o cliente combinou o horário na conversa: a IA já confirma. Se a confirmação não passar, fica pendente (a equipe confirma)
        const confirmed = await setAppointmentStatus(env.tx, env.ctx, created.data.id, "confirmed", env.now);
        const status = confirmed.ok ? "confirmed" : "pending";
        await addEvent(env.tx, env.conv, `${sourceName} marcou ${type.name.toLowerCase()} para ${day} às ${zonedTime(at.toISOString(), env.ctx.timeZone)} (${status === "confirmed" ? "confirmado" : "pendente de confirmação"})`, env.now);
        await notifyAppointment(env, "appointment_booked", { contactId: scope.contactId, typeId: type.id, typeName: type.name, startsAt: at, ownerId: owner, pending: status === "pending" });
        return { id: created.data.id, typeId: type.id, startsAt: created.data.startsAt, status };
      },

      async rescheduleAppointment(scope, input) {
        assertScope(env, scope);
        const existing = await ownAppointment(env, scope, input.appointmentId);
        const type = await findType(env, existing.typeId);
        if (!type) throw new PortError("not_found", "Tipo de atendimento não encontrado.");
        const at = parseSlotId(input.slotId, type.id);
        if (!at) throw new PortError("invalid", "Horário inválido. Liste os horários livres de novo.");
        const day = zonedDay(at.toISOString(), env.ctx.timeZone);
        const offered = await freeSlots(env, type, existing.ownerId, day, day);
        if (!offered.some((s) => s.getTime() === at.getTime())) throw new PortError("conflict", "Esse horário não está mais livre. Liste os horários de novo.");
        const updated = await updateAppointment(
          env.tx,
          env.ctx,
          existing.id,
          {
            contactId: scope.contactId,
            typeId: type.id,
            ownerId: existing.ownerId,
            date: day,
            time: zonedTime(at.toISOString(), env.ctx.timeZone),
            durationMinutes: type.durationMinutes,
            notes: existing.notes ?? "",
            allowConflict: false,
          },
          env.now,
        );
        if (!updated.ok) throw new PortError(updated.error === "conflict" ? "conflict" : "invalid", updated.message);
        // mover um agendamento o volta para "pendente"; o cliente acabou de escolher o novo horário, então a IA confirma
        const confirmed = await setAppointmentStatus(env.tx, env.ctx, existing.id, "confirmed", env.now);
        await notifyAppointment(env, "appointment_rescheduled", { contactId: scope.contactId, typeId: type.id, typeName: type.name, startsAt: at, ownerId: existing.ownerId, pending: !confirmed.ok });
        return { id: updated.data.id, typeId: type.id, startsAt: updated.data.startsAt, status: confirmed.ok ? "confirmed" : "pending" };
      },

      async cancelAppointment(scope, input) {
        assertScope(env, scope);
        const existing = await ownAppointment(env, scope, input.appointmentId);
        const result = await setAppointmentStatus(env.tx, env.ctx, existing.id, "canceled", env.now);
        if (!result.ok) throw new PortError("invalid", result.message);
        await notifyAppointment(env, "appointment_canceled", { contactId: scope.contactId, typeId: existing.typeId, startsAt: existing.startsAt, ownerId: existing.ownerId });
      },
    },

    contacts: {
      async getContact(scope): Promise<ContactInfo | null> {
        assertScope(env, scope);
        const [c] = await env.tx.select({ name: contacts.name, email: contacts.email, phone: contacts.phone }).from(contacts).where(eq(contacts.id, scope.contactId)).limit(1);
        if (!c) return null;
        const tagRows = await env.tx
          .select({ name: tags.name })
          .from(contactTags)
          .innerJoin(tags, eq(tags.id, contactTags.tagId))
          .where(eq(contactTags.contactId, scope.contactId));
        return { name: c.name === c.phone ? null : c.name, email: c.email, phone: c.phone, tags: tagRows.map((t) => t.name) };
      },

      async updateFields(scope, fields) {
        assertScope(env, scope);
        const patch: Partial<typeof contacts.$inferInsert> = { updatedAt: env.now };
        if (fields.name) patch.name = fields.name.slice(0, 120);
        if (fields.email) patch.email = fields.email.slice(0, 200);
        await env.tx.update(contacts).set(patch).where(and(eq(contacts.organizationId, org), eq(contacts.id, scope.contactId)));
      },

      async addTag(scope, tagName) {
        assertScope(env, scope);
        const all = await loadTags(env.tx, env.ctx);
        const tag = all.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
        if (!tag) throw new PortError("not_found", "Etiqueta não encontrada.");
        if (tag.funnelStage !== null) {
          await setFunnelStage(env.tx, org, scope.contactId, tag.id, tag.name);
          queueRealtime(env.tx, org, { type: "conversation.updated", conversationId: env.conv.id, reason: "stage" });
        } else await env.tx.insert(contactTags).values({ organizationId: org, contactId: scope.contactId, tagId: tag.id }).onConflictDoNothing();
      },
    },

    conversations: {
      async requestHuman(scope, reason) {
        assertScope(env, scope);
        await env.tx
          .update(conversations)
          .set({
            status: "handoff_requested",
            waitingSince: env.conv.waitingSince ?? env.now,
            assigneeId: null,
            aiDueAt: null,
            updatedAt: env.now,
          })
          .where(eq(conversations.id, env.conv.id));
        await addEvent(env.tx, env.conv, `${env.agentName} chamou a equipe: ${reason}`, env.now);
        queueRealtime(env.tx, org, { type: "conversation.updated", conversationId: env.conv.id, reason: "handoff" });
        queueRealtime(env.tx, org, { type: "home.invalidate" });
      },

      async scheduleFollowup(scope, input) {
        assertScope(env, scope);
        await env.tx.update(conversations).set({ followUpAt: input.runAt, followUpPaused: false, updatedAt: env.now }).where(eq(conversations.id, env.conv.id));
        queueRealtime(env.tx, org, { type: "conversation.updated", conversationId: env.conv.id, reason: "follow_up" });
      },

      async markOptOut(scope) {
        assertScope(env, scope);
        await registerOptOut(env.tx, org, scope.contactId, env.lastCustomerText || "SAIR", env.now);
      },
    },
  };
}

async function ownAppointment(env: PortsEnv, scope: Scope, appointmentId: string) {
  if (!isGuid(appointmentId)) throw new PortError("not_found", "Agendamento não encontrado.");
  const [row] = await env.tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.organizationId, env.ctx.organizationId), eq(appointments.id, appointmentId), eq(appointments.contactId, scope.contactId)))
    .limit(1);
  // agendamento de OUTRO cliente é "não existe" para a IA
  if (!row) throw new PortError("not_found", "Agendamento não encontrado.");
  return row;
}

