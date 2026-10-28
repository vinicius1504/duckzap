import type { AgentConfig, AgentTool } from "@duckzap/contracts/agents";

// Recursos do agente: as "Ferramentas da IA" que a pessoa liga e desliga. Agendamento é automático para qualquer agente
// (derivado dos tipos de atendimento ativos da Agenda) e o follow-up é um agente fixo do sistema, então as ferramentas
// desses dois não aparecem na tela — os valores guardados na config ficam como estão. Funções puras e imutáveis.

/** Ferramentas de agenda e de retomada: não são editadas na tela. */
export const HIDDEN_TOOLS: readonly AgentTool[] = ["list_available_slots", "book_appointment", "reschedule_appointment", "schedule_followup"];

/** Ferramentas que aparecem em "Ferramentas da IA". */
export function standaloneTools(all: readonly AgentTool[]): AgentTool[] {
  return all.filter((tool) => !HIDDEN_TOOLS.includes(tool));
}

/** Liga/desliga uma ferramenta. `request_human` é sempre ligada; as ferramentas escondidas não mudam. */
export function setToolEnabled(config: AgentConfig, tool: AgentTool, on: boolean): AgentConfig {
  if (tool === "request_human" || HIDDEN_TOOLS.includes(tool)) return config;
  const tools = on ? (config.advanced.tools.includes(tool) ? config.advanced.tools : [...config.advanced.tools, tool]) : config.advanced.tools.filter((t) => t !== tool);
  return { ...config, advanced: { ...config.advanced, tools } };
}
