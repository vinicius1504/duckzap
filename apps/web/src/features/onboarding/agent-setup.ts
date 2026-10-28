import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { Agent } from "@duckzap/contracts/agents";
import type { AgentDraft, AgentSetup, CompanyStepInput } from "@duckzap/contracts/onboarding";
import {
  createAgent,
  getAgent,
  listAgents,
  listAppointmentTypes,
  removeAgentDocument,
  setAgentStatus,
  updateAgentConfig,
  uploadAgentDocument,
} from "@/features/agents/api";
import { getChannelsOverview, updateChannelSettings } from "@/features/channels/api";
import { keepExamples, mapDraftToAgent, OFFERING_DOCUMENT_NAME, sameConfig } from "@/lib/onboarding-agent";
import { fail, ok, type Result } from "@/lib/mock";

// Ao concluir o cadastro, o rascunho do agente vira um agente REAL (módulo Agentes), com o que a pessoa vende como documento
// de conhecimento, ligado ao canal criado no passo do WhatsApp (`channels.agent_id`) e ligado só se esse canal estiver conectado.
// Refazer o passo (voltar e concluir de novo, ou o servidor do front reiniciar) ATUALIZA o mesmo agente: ele é achado pelo id
// guardado no progresso do cadastro ou, na falta dele, pelo nome "Agente <empresa>".
// Qualquer falha devolve uma mensagem clara; a empresa e o canal já salvos não são tocados e a pessoa tenta de novo.

const RETRY = "Sua empresa e o WhatsApp já estão salvos. Tente concluir de novo em instantes.";
const unavailable = (detail: string) => fail("unavailable" as const, `${detail} ${RETRY}`);

/** Agente do cadastro: o do progresso (se ainda existe) ou o que tem o nome esperado. */
async function findOnboardingAgent(knownId: string | undefined, name: string): Promise<Agent | null> {
  if (knownId) {
    const known = await getAgent(knownId);
    if (known) return known;
  }
  const all = await listAgents();
  return all.find((a) => a.config.name === name) ?? null;
}

export async function setupOnboardingAgent(input: {
  draft: AgentDraft;
  company: CompanyStepInput;
  channelId: string | undefined;
  knownAgentId: string | undefined;
  /** Chamado assim que o id do agente existe, para um novo clique em "concluir" reaproveitá-lo mesmo se algo falhar depois. */
  onAgentId: (agentId: string) => void;
}): Promise<Result<AgentSetup, "unavailable">> {
  const { draft, company, channelId } = input;
  try {
    // tipos de atendimento da Agenda: só quem quer "Agendar" precisa deles
    let bookableTypeIds: string[] = [];
    if (draft.goal === "scheduling") {
      bookableTypeIds = (await listAppointmentTypes().catch(() => [])).filter((t) => !t.staffOnly).map((t) => t.id);
    }
    const mapped = mapDraftToAgent(draft, company, bookableTypeIds);

    // 1. agente: acha o do cadastro ou cria
    let agent = await findOnboardingAgent(input.knownAgentId, mapped.name);
    if (!agent) {
      const created = await createAgent({ name: mapped.name, job: mapped.job, channelIds: [] }, "");
      if (!created.ok) return unavailable(`Não foi possível criar o agente: ${created.message}`);
      agent = created.data;
    }
    input.onAgentId(agent.id);

    // 2. configuração (nome, tom, prompt, conhecimento). Sem mudança, não cria versão nova.
    const nextConfig = keepExamples(mapped.config, agent.config);
    if (!sameConfig(agent.config, nextConfig)) {
      const saved = await updateAgentConfig(agent.id, nextConfig, "");
      if (!saved.ok) return unavailable(`Não foi possível salvar a configuração do agente: ${saved.message}`);
      agent = saved.data;
    }

    // 3. o que a empresa vende vira documento de conhecimento (sobe o novo antes de tirar o antigo)
    const previous = agent.documents.filter((d) => d.name === OFFERING_DOCUMENT_NAME);
    const doc = await uploadAgentDocument(agent.id, { name: mapped.knowledge.name, sizeBytes: mapped.knowledge.sizeBytes, text: mapped.knowledge.text });
    if (!doc.ok) return unavailable(`Não foi possível guardar o que você vende no conhecimento do agente: ${doc.message}`);
    if (doc.data.status !== "ready") return unavailable(`Não foi possível guardar o que você vende no conhecimento do agente: ${doc.data.error ?? "o texto não pôde ser lido."}`);
    for (const old of previous) await removeAgentDocument(agent.id, old.id);

    // 4. canal criado no passo do WhatsApp: liga o agente a ele (só se o canal ainda não tem outro agente)
    let channelLinked = false;
    let channelConnected = false;
    if (channelId) {
      const overview = await getChannelsOverview();
      const channel = overview.channels.find((c) => c.id === channelId);
      if (channel) {
        channelConnected = channel.status === "connected";
        if (channel.agentId === agent.id) channelLinked = true;
        else if (channel.agentId === null) {
          const linked = await updateChannelSettings(channel.id, {
            teamId: channel.teamId,
            agentId: agent.id,
            messages: channel.messages,
            inactivityTransferMinutes: channel.inactivityTransferMinutes,
          });
          if (!linked.ok) return unavailable(`Não foi possível ligar o agente ao seu WhatsApp: ${linked.message}`);
          channelLinked = true;
        }
      }
    }

    // 5. liga o agente só com canal conectado; sem isso ele fica criado e inativo
    let active = agent.status === "active" && channelLinked && channelConnected;
    let activationError: string | null = null;
    if (channelLinked && channelConnected && agent.status !== "active") {
      const activated = await setAgentStatus(agent.id, "active");
      if (activated.ok) active = true;
      else activationError = activated.message;
    } else if (!(channelLinked && channelConnected) && agent.status === "active") {
      // ligado numa tentativa anterior, mas sem canal conectado agora: não responde, então a tela não diz que está ativo
      active = false;
    }

    return ok({
      agentId: agent.id,
      name: mapped.name,
      active,
      channelLinked,
      channelConnected,
      needsAppointmentTypes: draft.goal === "scheduling" && bookableTypeIds.length === 0,
      activationError,
    });
  } catch (error) {
    unstable_rethrow(error); // sessão expirada / conta suspensa redirecionam: isso não é falha do agente
    return unavailable("Não conseguimos falar com o servidor.");
  }
}
