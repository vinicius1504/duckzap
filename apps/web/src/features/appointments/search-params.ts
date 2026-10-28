import { can } from "@duckzap/contracts/permissions";
import type { MemberRole } from "@duckzap/contracts/session";
import { parseAsString, parseAsStringLiteral } from "nuqs/server";
import { z } from "zod";
import type { AgendaView } from "./time";

// Estado da Agenda na URL: ?visao=semana&data=2026-10-26&responsavel=usr_marina&tipo=typ_limpeza
// ?novo=1&cliente=<id> abre "Novo agendamento" já com o cliente (vindo da ficha em Clientes).

export const views = ["mes", "semana", "lista"] as const satisfies readonly AgendaView[];

export const agendaParsers = {
  visao: parseAsStringLiteral(views).withDefault("semana"),
  data: parseAsString,
  responsavel: parseAsString,
  tipo: parseAsString,
  novo: parseAsString,
  cliente: parseAsString,
};

const one = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.string().optional());

const schema = z.object({
  visao: one.pipe(z.enum(views).optional()).catch(undefined),
  data: one.pipe(z.iso.date().optional()).catch(undefined),
  responsavel: one.catch(undefined),
  tipo: one.catch(undefined),
  novo: one.catch(undefined),
  cliente: one.catch(undefined),
});

export function parseAgendaSearch(raw: Record<string, string | string[] | undefined>, today: string) {
  const p = schema.parse(raw);
  return {
    view: p.visao ?? "semana",
    anchor: p.data ?? today,
    ownerId: p.responsavel || undefined,
    typeId: p.tipo || undefined,
    newFor: p.novo ? { contactId: p.cliente ?? null } : null,
  };
}

/** O que o papel pode fazer na Agenda (a Server Action é quem autoriza de verdade). */
export function agendaPerms(role: MemberRole) {
  return {
    manage: can(role, "appointment.manage"),
    /** Tipos de atendimento e lembretes: sem permissão própria na matriz, usa settings.manage. */
    settings: can(role, "settings.manage"),
    integration: can(role, "integration.manage"),
  };
}
export type AgendaPerms = ReturnType<typeof agendaPerms>;
