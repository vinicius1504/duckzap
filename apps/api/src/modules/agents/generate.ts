import { AgentGeneratorError, generateAgentProfile, LlmError, tokenBudget, type LlmRetryOptions, type UsageEvent } from "@duckzap/ai";
import { agentGeneratorOutputSchema, type AgentGeneratorOutput, type AgentGeneratorParsedInput } from "@duckzap/contracts/agents";
import { withOrg } from "@duckzap/db";
import { resolvePlan, tokenLimitValue } from "../../lib/plan";
import { err, ok, type Res } from "./http";
import { monthlyTokens, recordUsage, type Ctx } from "./service";

/** Prazo total do pedido (inclui a nova tentativa por resposta inválida e as repetições por falha passageira do provedor). */
export const GENERATE_TOTAL_TIMEOUT_MS = 270_000;

export type GenerateOptions = {
  /** Esperas entre novas tentativas do provedor (testes injetam uma que não espera). */
  retry?: LlmRetryOptions;
  signal?: AbortSignal;
};

/**
 * Gera o conteúdo do agente a partir dos dados da empresa. SEM estado: não grava agente nem versão; o dono revisa, edita e
 * salva pelas rotas de agentes. Só grava `ai_usage_log` (purpose `agent_generator`), inclusive quando a geração falha
 * depois de gastar tokens, e respeita o orçamento mensal de tokens do plano.
 */
export async function generateAgent(context: Ctx, input: AgentGeneratorParsedInput, options: GenerateOptions = {}): Promise<Res<AgentGeneratorOutput>> {
  const { deps, actor } = context;

  const budget = await withOrg(deps.db, actor.organizationId, async (tx) => {
    const used = await monthlyTokens(tx, actor);
    return tokenBudget(used, tokenLimitValue(await resolvePlan(tx, actor.organizationId)));
  });
  if (budget.exceeded) {
    return err(402, "budget_exceeded", "Você usou todo o limite de IA do mês no seu plano. Fale com o suporte ou mude de plano para gerar o perfil.");
  }

  const events: UsageEvent[] = [];
  const signal = AbortSignal.any([AbortSignal.timeout(GENERATE_TOTAL_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  try {
    const { profile } = await generateAgentProfile({
      llm: deps.llm,
      input,
      organizationId: actor.organizationId,
      signal,
      onUsage: (e) => void events.push(e),
      retry: options.retry,
    });
    const checked = agentGeneratorOutputSchema.safeParse(profile);
    if (!checked.success) {
      console.error({ msg: "agent generator: saída fora do contrato", issues: checked.error.issues.length });
      return err(502, "generation_failed", "Não consegui montar o perfil desta vez. Tente de novo em instantes.");
    }
    return ok(checked.data);
  } catch (error) {
    if (error instanceof AgentGeneratorError) {
      console.error({ msg: "agent generator: resposta inválida após nova tentativa", organizationId: actor.organizationId, problems: error.details.length });
      return err(502, "generation_failed", "A IA não devolveu um perfil válido, mesmo após uma nova tentativa. Tente de novo; se persistir, resuma o texto da empresa.");
    }
    if (error instanceof LlmError && error.retryable) {
      console.error({ msg: "agent generator: provedor indisponível", organizationId: actor.organizationId, code: error.code });
      return err(503, "ai_unavailable", "A IA está indisponível ou sobrecarregada agora. Tente de novo em alguns instantes.");
    }
    console.error({ msg: "agent generator: falha", organizationId: actor.organizationId, err: error instanceof Error ? error.name : "erro" });
    return err(502, "generation_failed", "Não consegui gerar o perfil agora. Tente de novo em instantes.");
  } finally {
    await recordUsage(context, events, { agentId: null, conversationId: null });
  }
}

const FIELD_LABELS: Record<string, string> = {
  purpose: "finalidade",
  agentName: "nome do agente",
  tone: "tom",
  companyText: "texto da empresa",
  sells: "o que vende",
  doesNotSell: "o que não vende",
  paymentMethods: "formas de pagamento",
  hours: "horário",
  location: "localização",
  budgetProcess: "como funciona o orçamento",
  askBeforeHandoff: "o que perguntar antes de transferir",
  handoffRules: "quando chamar uma pessoa",
  restrictions: "restrições",
  customInstructions: "instruções personalizadas",
};

/** Erro de validação do corpo no formato da API: `{ message: 'Campo "texto da empresa": …', fields }`. */
export function formatGeneratorIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  const fields: Record<string, string> = {};
  let message: string | null = null;
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_");
    const label = FIELD_LABELS[key];
    message ??= label ? `Campo "${label}": ${issue.message}` : issue.message;
    fields[key] ??= issue.message;
  }
  return { message: message ?? "Confira os campos.", fields };
}
