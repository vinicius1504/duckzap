import type { AgentConfig, AgentJob, AgentStatus, AgentTool, KnowledgeDocument } from "@duckzap/contracts/agents";
import type { ChipTone } from "@duckzap/ui/components/chip";

export const jobView: Record<AgentJob, { label: string; description: string }> = {
  support: { label: "Atendimento", description: "Responde dúvidas e chama a equipe quando precisa" },
  follow_up: { label: "Follow-up", description: "Retoma conversas paradas no tempo certo" },
  scheduling: { label: "Agendamento", description: "Marca e remarca horários na Agenda" },
  instagram_dm: { label: "Instagram DM", description: "Responde o Direct do Instagram" },
  comments: { label: "Comentários", description: "Responde comentários públicos do Instagram" },
};

export const agentStatusView: Record<AgentStatus, { label: string; tone: ChipTone }> = {
  active: { label: "Ativo", tone: "ok" },
  paused: { label: "Pausado", tone: "warn" },
  inactive: { label: "Inativo", tone: "neutral" },
};

export const toneLabel: Record<AgentConfig["profile"]["tone"], string> = {
  friendly: "Amigável",
  formal: "Formal",
  direct: "Direto",
};

export const respondWhenLabel: Record<AgentConfig["behavior"]["respondWhen"], string> = {
  always: "Sempre, em qualquer horário",
  outside_hours: "Só fora do horário de atendimento",
  no_reply_5min: "Só quando ninguém responder em 5 min",
};

export const toolView: Record<AgentTool, { label: string; hint: string }> = {
  search_knowledge: { label: "Buscar no conhecimento", hint: "Consulta textos e documentos do agente" },
  list_available_slots: { label: "Ver horários livres", hint: "Lê a Agenda" },
  book_appointment: { label: "Marcar horário", hint: "Cria agendamento pendente, só nos tipos liberados" },
  reschedule_appointment: { label: "Remarcar ou cancelar", hint: "Só agendamentos do próprio cliente" },
  update_contact_fields: { label: "Atualizar nome e e-mail", hint: "Só esses campos" },
  add_tag: { label: "Mudar etapa do funil", hint: "Só etiquetas permitidas" },
  request_human: { label: "Chamar uma pessoa", hint: "Sempre ligada" },
  schedule_followup: { label: "Agendar retomada", hint: "Respeita o horário comercial" },
};

export const documentStatusView: Record<KnowledgeDocument["status"], { label: string; tone: ChipTone }> = {
  processing: { label: "Lendo…", tone: "info" },
  ready: { label: "Lido pelo agente", tone: "ok" },
  failed: { label: "Falhou", tone: "err" },
};

/** 120 → "Após 2 h"; 1440 → "Após 24 h"; 4320 → "Após 3 dias" */
export function delayLabel(minutes: number) {
  if (minutes < 60) return `Após ${minutes} min`;
  const hours = minutes / 60;
  if (hours <= 24) return `Após ${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
  const days = Math.round(hours / 24);
  return `Após ${days} ${days === 1 ? "dia" : "dias"}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
