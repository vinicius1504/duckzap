import {
  bookableTypeIds,
  createDemoLlm,
  effectiveSchedulingConfig,
  createSimulatorPorts,
  runAgentTurn,
  type AppointmentTypeInfo,
  type KnowledgePort,
  type LLMProvider,
  type ToolName,
  type UsageEvent,
} from "@duckzap/ai";
import type { AgentConfig, SimulatorMessage, SimulatorReply } from "@duckzap/contracts/agents";

/**
 * Simulador (§4.3): MESMO pipeline do agente, em modo `simulator` — tools de escrita em dry-run, agenda/contato
 * fictícios, conhecimento real só para leitura. Nunca envia mensagem nem grava dado de cliente.
 * Sem provedor de IA configurado (LLM_PROVIDER=fake) usa o LLM de demonstração por regras, para a tela funcionar.
 */

/** O contrato de tools do front não tem cancel_appointment: ele é exibido como reschedule_appointment. */
const toContractTool = (tool: ToolName): SimulatorReply["toolCalls"][number]["tool"] => (tool === "cancel_appointment" ? "reschedule_appointment" : tool);

export function pickSimulatorLlm(llm: LLMProvider): LLMProvider {
  return llm.name === "fake" ? createDemoLlm() : llm;
}

export async function simulateReply(input: {
  llm: LLMProvider;
  organizationId: string;
  agentId: string;
  config: AgentConfig;
  history: SimulatorMessage[];
  knowledge: KnowledgePort;
  types: AppointmentTypeInfo[];
  remainingTokens?: number;
  now?: Date;
  urlAllowlist?: string[];
  onUsage?: (event: UsageEvent) => void;
}): Promise<SimulatorReply> {
  const now = input.now ?? new Date();
  const { ports } = createSimulatorPorts({ knowledge: input.knowledge, types: input.types, now: () => now });
  const result = await runAgentTurn({
    scope: { organizationId: input.organizationId, conversationId: `sim_${input.agentId}`, contactId: "contato_ficticio", agentId: input.agentId },
    mode: "simulator",
    // agenda derivada dos tipos ativos da empresa (config.scheduling e as ferramentas de agenda do agente são legado e ignorados)
    config: effectiveSchedulingConfig(input.config, bookableTypeIds(input.types)),
    state: "ai_active",
    history: input.history.map((m) => ({ role: m.role, text: m.text })),
    llm: pickSimulatorLlm(input.llm),
    ports,
    now,
    urlAllowlist: input.urlAllowlist,
    budget: input.remainingTokens === undefined ? undefined : { remainingTokens: input.remainingTokens },
    onUsage: input.onUsage,
  });
  return {
    messages: result.messages,
    toolCalls: result.toolCalls.map((t) => ({ tool: toContractTool(t.tool), args: t.args, result: t.result })),
    handoff: result.handoff ? { reason: result.handoff.reason } : null,
    intent: result.intent ?? "question",
  };
}
