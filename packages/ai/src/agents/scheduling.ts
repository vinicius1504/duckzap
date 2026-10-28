import type { AgentRuntimeConfig } from "./types";

/**
 * Agendar é função do SISTEMA, não de cada agente: qualquer agente que atende (ao vivo, Copiloto e simulador) vê horários,
 * marca e remarca quando a empresa tem ao menos um tipo de atendimento ativo na Agenda. Sem tipo ativo, as ferramentas de
 * agenda não existem e a IA não promete marcar.
 *
 * `config.scheduling` (`canBook`, `appointmentTypeIds`) e a presença das ferramentas de agenda em `advanced.tools` são LEGADO:
 * continuam válidos no schema (nada é apagado nem migrado), mas esta função os sobrescreve. Quem monta o turno chama
 * `effectiveSchedulingConfig` ANTES de `runAgentTurn`, com os tipos da empresa do próprio tenant.
 */

/** Ferramentas que dependem da Agenda. `cancel_appointment` acompanha `reschedule_appointment` (ver `enabledToolNames`). */
export const SCHEDULING_TOOLS = ["list_available_slots", "book_appointment", "reschedule_appointment", "cancel_appointment"] as const;
// `update_contact_fields` vai junto: para marcar, a IA precisa poder salvar o nome que o cliente informar
const GRANTED_TOOLS = ["list_available_slots", "book_appointment", "reschedule_appointment", "update_contact_fields"] as const;

/** Tipos que a IA pode oferecer: ativos e que não sejam "só a equipe marca" (a IA nunca marca esses, §4.2). */
export function bookableTypeIds(types: readonly { id: string; active?: boolean; staffOnly?: boolean }[]): string[] {
  const ids: string[] = [];
  for (const t of types) if (t.active !== false && !t.staffOnly && !ids.includes(t.id)) ids.push(t.id);
  return ids;
}

/** Devolve uma cópia da config com a agenda derivada da empresa. Pura: não muda o objeto recebido. */
export function effectiveSchedulingConfig(config: AgentRuntimeConfig, bookableIds: readonly string[]): AgentRuntimeConfig {
  const ids = [...new Set(bookableIds)];
  const others = config.advanced.tools.filter(
    (tool) => !(SCHEDULING_TOOLS as readonly string[]).includes(tool) && !(ids.length > 0 && tool === "update_contact_fields"),
  );
  return {
    ...config,
    scheduling: { canBook: ids.length > 0, appointmentTypeIds: ids },
    advanced: { ...config.advanced, tools: ids.length > 0 ? [...others, ...GRANTED_TOOLS] : others },
  };
}
