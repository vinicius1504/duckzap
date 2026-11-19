import "server-only";
import {
  onboardingStateSchema,
  type AgentDraft,
  type AgentSetup,
  type CompanyStepInput,
  type OfficialApiInput,
  type OnboardingDraft,
  type OnboardingState,
  type PreviewMessage,
  type QrSession,
  type SignUpInput,
} from "@duckzap/contracts/onboarding";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { getAgent, listAppointmentTypes } from "@/features/agents/api";
import {
  connectOfficialChannel,
  createChannel,
  getChannelsOverview,
  getQrSession as getChannelQr,
  startQrSession as startChannelQr,
} from "@/features/channels/api";
import { apiFetch, forwardSetCookies } from "@/lib/api-server";
import { fail, mockDelay, ok, type Result } from "@/lib/mock";
import { describeHours } from "@/lib/onboarding-agent";
import { setupOnboardingAgent } from "./agent-setup";
import { defaultAgent, defaultCompany, sampleQuestion } from "./mock-data";

// Ligado ao back. O estado do cadastro é DURÁVEL e vem do banco pela sessão (nada na memória do front, nem cookie):
//   createSignUp  → POST /v1/auth/sign-up/email (Better Auth cria o usuário e já entra; o cookie de sessão é repassado)
//   getDraft      → GET  /v1/onboarding (conta, segurança/2FA, empresa, WhatsApp conectado/pulado, canal, agente e conclusão)
//   Segurança     → 2FA em /v1/account/two-factor/* (features/security); "pular" → POST /v1/onboarding/security/skip
//   saveCompany   → POST /v1/onboarding/organization (1ª vez) ou PUT /v1/onboarding/company (voltou para editar)
//   WhatsApp      → módulo Canais (canal real); "pular" → POST /v1/onboarding/whatsapp/skip
//   completeOnboarding → cria/atualiza o agente REAL (módulo Agentes, ver agent-setup.ts) e POST /v1/onboarding/complete
// Continuam de exemplo: simulateAgentReply e getSampleConversation (a PRÉVIA do agente, que nunca grava nada).

/**
 * Só para a tela "pronto" logo depois de concluir: o motivo de o agente não ter sido ligado (ex.: limite do plano) não
 * existe no banco. É cosmético; sem ele (outro servidor, reinício) a tela mostra o estado real do agente, só sem o motivo.
 */
const store = globalThis as typeof globalThis & { __duckchatActivationError?: Map<string, string> };
const activationErrors = (store.__duckchatActivationError ??= new Map<string, string>());

const expiredMessage = "Seu cadastro expirou. Comece de novo.";

const signUpResponseSchema = z.object({ user: z.object({ id: z.string() }) });

export async function createSignUp(input: SignUpInput): Promise<Result<{ draftId: string }, "email_taken" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch("/v1/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ name: input.name, email: input.email, password: input.password }),
    });
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.status === 429) return fail("unavailable", "Muitas tentativas. Aguarde um minuto e tente de novo.");
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (typeof body?.code === "string" && body.code.startsWith("USER_ALREADY_EXISTS")) {
      return fail("email_taken", "Este e-mail já tem conta. Entre com ele ou use outro.");
    }
    return fail("unavailable", "Não foi possível criar a conta com esses dados. Se você já tem conta, entre ou use \"Esqueci a senha\".");
  }
  const parsed = signUpResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return fail("unavailable", "Não foi possível criar a conta. Tente de novo.");
  await forwardSetCookies(response); // a conta já nasce logada
  return ok({ draftId: parsed.data.user.id });
}

/** Estado do cadastro da pessoa logada (null = sem sessão ou API fora do ar). */
async function getState(): Promise<OnboardingState | null> {
  let response: Response;
  try {
    response = await apiFetch("/v1/onboarding");
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const parsed = onboardingStateSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** O agente real da empresa, como a tela "pronto" mostra (derivado de Agentes e Canais; falha = sem resumo). */
async function agentSetupOf(state: OnboardingState): Promise<AgentSetup | null> {
  if (!state.agentId) return null;
  try {
    const agent = await getAgent(state.agentId);
    if (!agent) return null;
    const overview = await getChannelsOverview();
    const channel =
      overview.channels.find((c) => c.agentId === agent.id) ?? overview.channels.find((c) => c.id === state.channelId);
    const channelLinked = channel?.agentId === agent.id;
    const channelConnected = channel?.status === "connected";
    const needsAppointmentTypes =
      agent.job === "scheduling" && (await listAppointmentTypes().catch(() => [])).filter((t) => !t.staffOnly).length === 0;
    return {
      agentId: agent.id,
      name: agent.config.name,
      active: agent.status === "active" && channelLinked && channelConnected,
      channelLinked,
      channelConnected,
      needsAppointmentTypes,
      activationError: activationErrors.get(agent.id) ?? null,
    };
  } catch (error) {
    unstable_rethrow(error); // sessão expirada / portão de acesso redirecionam
    return null;
  }
}

/** Rascunho da pessoa logada, todo derivado do banco (null = sem sessão). O resumo do agente só depois de concluir ("pronto"). */
export async function getDraft(): Promise<OnboardingDraft | null> {
  const state = await getState();
  if (!state) return null;
  return {
    id: state.account.id,
    account: { name: state.account.name, email: state.account.email },
    security: state.security,
    company: state.company,
    role: state.role,
    whatsapp: state.whatsapp,
    agentSetup: state.completedAt ? await agentSetupOf(state) : null,
    completedAt: state.completedAt,
  };
}

/** Valores iniciais dos passos (o que já foi salvo ou o padrão do design). */
export async function getStepDefaults(
  draft: OnboardingDraft,
): Promise<{ company: CompanyStepInput; agent: AgentDraft }> {
  return {
    company: draft.company ?? defaultCompany(),
    agent: defaultAgent,
  };
}

export async function saveCompany(input: CompanyStepInput): Promise<Result<null, "not_found" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch("/v1/onboarding/organization", { method: "POST", body: JSON.stringify(input) });
    if (response.status === 409) {
      // a empresa já existe (a pessoa voltou para editar o passo): atualiza
      response = await apiFetch("/v1/onboarding/company", { method: "PUT", body: JSON.stringify(input) });
    }
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.status === 401) return fail("not_found", expiredMessage);
  if (!response.ok) return fail("unavailable", "Não foi possível salvar a empresa. Confira os dados e tente de novo.");
  return ok(null);
}

// ───────────── WhatsApp REAL (módulo Canais) ─────────────

/** Nome do canal criado pelo cadastro. Se a pessoa voltar ao passo, reaproveita o mesmo canal. */
const ONBOARDING_CHANNEL_NAME = "WhatsApp principal";

/** Cria o canal real (ou reaproveita o do próprio cadastro, se a pessoa voltou ao passo). */
async function ensureChannel(type: "whatsapp_qr" | "whatsapp_official"): Promise<Result<{ id: string }, "unavailable">> {
  const created = await createChannel({ type, name: ONBOARDING_CHANNEL_NAME });
  if (created.ok) return ok({ id: created.data.id });
  if (created.error === "duplicate_name") {
    const overview = await getChannelsOverview().catch(() => null);
    const existing = overview?.channels.find((c) => c.name === ONBOARDING_CHANNEL_NAME && c.type === type);
    if (existing) return ok({ id: existing.id });
  }
  return fail("unavailable", `${created.message} Você pode pular esta etapa e conectar depois, em Canais.`);
}

async function phoneOf(channelId: string): Promise<string | null> {
  const overview = await getChannelsOverview().catch(() => null);
  return overview?.channels.find((c) => c.id === channelId)?.address ?? null;
}

/** QR REAL: cria o canal pelo módulo Canais e pede o QR à Evolution. Só vira "conectado" quando o celular lê de verdade. */
export async function startQrSession(): Promise<Result<QrSession, "not_found" | "unavailable">> {
  const channel = await ensureChannel("whatsapp_qr");
  if (!channel.ok) return channel;
  const started = await startChannelQr(channel.data.id);
  if (!started.ok) return fail("unavailable", "Não conseguimos gerar o QR Code agora. Tente de novo ou conecte depois, em Canais.");
  return ok({
    id: channel.data.id,
    payload: started.data.payload,
    expiresAt: started.data.expiresAt,
    status: started.data.status === "waiting" ? "pending" : started.data.status,
    phone: null,
  });
}

/**
 * Estado do QR. O id da sessão de QR É o id do canal (devolvido por `startQrSession`); a API só acha canais da empresa
 * da sessão (RLS), então um id de outra empresa responde "não encontrado". Conectado = passo feito (quem diz é o banco).
 */
export async function getQrSession(channelId: string): Promise<Result<QrSession, "not_found">> {
  const current = await getChannelQr(channelId);
  if (!current.ok) return fail("not_found", "Código não encontrado. Gere um novo.");
  const status = current.data.status === "waiting" ? "pending" : current.data.status;
  const phone = status === "connected" ? await phoneOf(channelId) : null;
  return ok({ id: channelId, payload: current.data.payload, expiresAt: current.data.expiresAt, status, phone });
}

/** API oficial REAL: cria o canal e valida as credenciais com a Meta (módulo Canais). */
export async function connectOfficialApi(input: OfficialApiInput): Promise<Result<{ phone: string }, "invalid_credentials">> {
  const channel = await ensureChannel("whatsapp_official");
  if (!channel.ok) return fail("invalid_credentials", channel.message);
  const connected = await connectOfficialChannel(channel.data.id, {
    phoneNumberId: input.phoneNumberId,
    businessAccountId: input.businessAccountId,
    accessToken: input.accessToken,
  });
  if (!connected.ok) {
    return fail(
      "invalid_credentials",
      connected.error === "invalid_credentials"
        ? "A Meta recusou esses dados. Confira o ID do número e o token e tente de novo."
        : connected.message,
    );
  }
  return ok({ phone: connected.data.address ?? "" });
}

/** POST sem corpo de resposta útil nas rotas do cadastro (`/v1/onboarding/*`). */
async function postOnboarding(path: string, failure: string): Promise<Result<null, "not_found" | "unavailable">> {
  let response: Response;
  try {
    response = await apiFetch(path, { method: "POST", body: "{}" });
  } catch {
    return fail("unavailable", "Não conseguimos falar com o servidor. Tente de novo em instantes.");
  }
  if (response.status === 401) return fail("not_found", expiredMessage);
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    if (body?.error?.code === "no_organization") return fail("not_found", "Preencha os dados da empresa antes de continuar.");
    return fail("unavailable", "Só quem administra a empresa pode fazer o cadastro.");
  }
  if (!response.ok) return fail("unavailable", failure);
  await response.body?.cancel();
  return ok(null);
}

/** "Pular" o WhatsApp: guardado na empresa (sobrevive a recarregar e a deploy). */
export async function skipWhatsapp(): Promise<Result<null, "not_found" | "unavailable">> {
  return postOnboarding("/v1/onboarding/whatsapp/skip", "Não foi possível pular esta etapa. Tente de novo.");
}

/**
 * Conclui o cadastro. Com um rascunho de agente, cria (ou atualiza, se a pessoa voltou) o agente REAL, com o que a empresa
 * vende no conhecimento e ligado ao canal do WhatsApp (ativo só se o canal estiver conectado). Se isso falhar, o cadastro
 * NÃO é marcado como concluído: a empresa e o canal continuam salvos e a pessoa tenta de novo no mesmo passo.
 * Sem agente ("Fazer depois"), só conclui. A conclusão é gravada no banco (POST /v1/onboarding/complete, idempotente).
 */
export async function completeOnboarding(agent: AgentDraft | null): Promise<Result<null, "not_found" | "unavailable">> {
  const current = await getState();
  if (!current) return fail("not_found", expiredMessage);
  if (!current.company) return fail("not_found", "Preencha os dados da empresa antes de continuar.");

  if (agent) {
    const setup = await setupOnboardingAgent({
      draft: agent,
      company: current.company,
      channelId: current.channelId ?? undefined,
      knownAgentId: current.agentId ?? undefined,
    });
    if (!setup.ok) return fail("unavailable", setup.message);
    if (setup.data.activationError) activationErrors.set(setup.data.agentId, setup.data.activationError);
    else activationErrors.delete(setup.data.agentId);
  }
  return postOnboarding("/v1/onboarding/complete", "Não foi possível concluir o cadastro. Tente de novo em instantes.");
}

/* ───────────── Simulador do agente (mock simples por palavras-chave) ───────────── */

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

function firstItem(offering: string) {
  return offering.split(/,| e /)[0]?.trim().toLowerCase() || "nossos serviços";
}

export async function simulateAgentReply(input: {
  agent: AgentDraft;
  company: CompanyStepInput | null;
  history: PreviewMessage[];
  message: string;
}): Promise<string> {
  await mockDelay(600);
  const { agent, company } = input;
  const text = norm(input.message);
  const rules = norm(agent.rules);
  const hello =
    agent.tone === "friendly" ? "Oi! " : agent.tone === "formal" ? "Olá, tudo bem? " : "";
  const offering = agent.offering.trim() || "nossos serviços";
  const has = (...words: string[]) => words.some((w) => text.includes(w));

  if (
    has("reclama", "atendente", "humano", "pessoa", "urgente", "urgencia", "problema", "gerente")
  ) {
    return agent.tone === "formal"
      ? "Compreendo. Vou transferir o seu atendimento para uma pessoa da nossa equipe, que responde por aqui em instantes."
      : "Entendi. Vou chamar uma pessoa da equipe para te ajudar, tudo bem? Ela responde por aqui em instantes.";
  }
  if (has("quanto", "preco", "valor", "custa", "orcamento")) {
    if (rules.includes("preco") || rules.includes("valor") || agent.goal === "scheduling") {
      return `${hello}O valor depende de uma avaliação rápida. Posso agendar uma para você ainda esta semana?`;
    }
    return `${hello}Os valores mudam conforme o serviço. Você procura ${firstItem(offering)} ou outro serviço? Te passo os detalhes.`;
  }
  if (has("horario", "aberto", "abre", "fecha", "funciona", "sabado", "domingo")) {
    const hours = company
      ? describeHours(company.businessHours)
      : "Atendemos em horário comercial.";
    return `${hello}${hours}${agent.goal === "scheduling" ? " Quer que eu já marque um horário?" : ""}`;
  }
  if (has("agendar", "agenda", "marcar", "consulta", "horarios")) {
    return `${hello}Tenho amanhã às 9h ou às 14h30. Qual fica melhor para você?`;
  }
  if (input.history.length === 0 && has("oi", "ola", "bom dia", "boa tarde", "boa noite")) {
    return `${hello}Como posso ajudar?`;
  }
  switch (agent.goal) {
    case "sales":
      return `${hello}Trabalhamos com ${offering.toLowerCase()}. Quer que eu te mande as opções e condições?`;
    case "scheduling":
      return `${hello}Posso marcar um horário para você. Qual dia fica melhor?`;
    default:
      return `${hello}Posso ajudar com ${offering.toLowerCase()}. O que você gostaria de saber?`;
  }
}

/** Primeira troca da prévia (o design abre com uma pergunta de preço). */
export async function getSampleConversation(
  agent: AgentDraft,
  company: CompanyStepInput | null,
): Promise<PreviewMessage[]> {
  // sem nada preenchido ainda, a prévia abre com a resposta do design
  const reply = agent.offering.trim()
    ? await simulateAgentReply({ agent, company, history: [], message: sampleQuestion })
    : "Oi! O valor depende de uma avaliação rápida. Posso agendar uma para você ainda esta semana?";
  return [
    { from: "customer", text: sampleQuestion },
    { from: "agent", text: reply },
  ];
}
