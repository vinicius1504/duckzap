import type { NotificationKind } from "@duckzap/contracts/notifications";
import { formatLocal } from "@duckzap/ai";

/** Quem recebe o aviso de um agendamento feito pela IA. Função pura: as listas já chegam filtradas (só gente ativa da empresa). */
export function notificationRecipients(input: {
  /** Membros ativos da equipe da conversa (vazio se a conversa não tem equipe ou a equipe ficou sem ninguém ativo). */
  teamMembers: readonly string[];
  /** Responsável pelo agendamento, se ainda for alguém ativo da empresa. */
  owner: string | null;
  /** Proprietários e administradores ativos da empresa (só entram quando não há equipe com gente). */
  admins: readonly string[];
}): string[] {
  const base = input.teamMembers.length > 0 ? input.teamMembers : input.admins;
  const all = input.owner ? [...base, input.owner] : [...base];
  return [...new Set(all)];
}

export type AppointmentNoticeInput = {
  kind: NotificationKind;
  /** Nome do agente de IA que fez a alteração. */
  agentName: string;
  /** Nome do cadastro do cliente (ou o telefone, se o cadastro só tem ele). */
  clientName: string;
  /** Tipo do atendimento ("Reunião de apresentação"). */
  typeName: string;
  /** Horário relevante: o novo (marcar/remarcar) ou o que foi cancelado. */
  startsAt: Date;
  timeZone: string;
  /** A IA marcou, mas a confirmação falhou: a equipe precisa confirmar. */
  pending?: boolean;
};

const VERB: Record<NotificationKind, string> = {
  appointment_booked: "marcou",
  appointment_rescheduled: "remarcou",
  appointment_canceled: "cancelou",
};

/** Título e corpo do aviso: "Jacan marcou um agendamento" / "Maria · Reunião · quinta-feira, 29/10 às 08:30". */
export function appointmentNotice(input: AppointmentNoticeInput): { title: string; body: string } {
  const when = formatLocal(input.startsAt.toISOString(), input.timeZone);
  const parts = [input.clientName, input.typeName, when];
  if (input.pending && input.kind !== "appointment_canceled") parts.push("pendente de confirmação");
  return { title: `${input.agentName} ${VERB[input.kind]} um agendamento`, body: parts.join(" · ") };
}
