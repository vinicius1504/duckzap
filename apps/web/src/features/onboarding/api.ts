import "server-only";
import {
  companyStepSchema,
  type AgentDraft,
  type AgentSetup,
  type CompanyStepInput,
  type OfficialApiInput,
  type OnboardingDraft,
  type PreviewMessage,
  type QrSession,
  type SignUpInput,
} from "@duckzap/contracts/onboarding";
import { z } from "zod";
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

// Ligado ao back:
//   createSignUp  → POST /v1/auth/sign-up/email (Better Auth cria o usuário e já entra; o cookie de sessão é repassado)
//   getDraft      → GET  /v1/onboarding           (conta + dados da empresa, se já criada)
//   saveCompany   → POST /v1/onboarding/organization (1ª vez) ou PUT /v1/onboarding/company (voltou para editar)
//   WhatsApp      → módulo Canais (canal real; o id fica no progresso em memória, chaveado pelo id da pessoa)
//   completeOnboarding → cria/atualiza o agente REAL (módulo Agentes) e liga ao canal: ver agent-setup.ts
// Continua em memória do servidor do front (chaveado pelo id da pessoa): o progresso do passo do WhatsApp, o rascunho do
// agente e o `completedAt`. Continuam de exemplo: skipWhatsapp (só marca o passo), simulateAgentReply e getSampleConversation
// (a PRÉVIA do agente, que nunca grava nada).

type MockProgress = {
  whatsapp: OnboardingDraft["whatsapp"];
  agent: AgentDraft | null;
  /** O agente real criado ao concluir, e o id dele (para refazer o passo atualizar o mesmo agente). */
  agentSetup: AgentSetup | null;
  agentId?: string;
  completedAt: string | null;
  qr: (QrSession & { createdAt: number }) | null;
  /** Canal real criado no passo de WhatsApp (QR ou API oficial). */
  channelId?: string;
};

const store = globalThis as typeof globalThis & { __duckchatOnboarding?: Map<string, MockProgress> };
const progress = (store.__duckchatOnboarding ??= new Map<string, MockProgress>());

function progressOf(id: string): MockProgress {
  let entry = progress.get(id);
  if (!entry) {
    entry = { whatsapp: null, agent: null, agentSetup: null, completedAt: null, qr: null };
    progress.set(id, entry);
  }
  return entry;
}

const expiredMessage = "Seu cadastro expirou. Comece de novo.";

const onboardingResponseSchema = z.object({
  account: z.object({ id: z.string(), name: z.string(), email: z.email() }),
  company: companyStepSchema.nullable(),
  hasOrganization: z.boolean(),
});

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

export async function getDraft(id: string): Promise<OnboardingDraft | null> {
  let response: Response;
  try {
    response = await apiFetch("/v1/onboarding");
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const parsed = onboardingResponseSchema.safeParse(await response.json().catch(() => null));
  // o rascunho só vale para a pessoa logada (o cookie do cadastro guarda o id dela)
  if (!parsed.success || parsed.data.account.id !== id) return null;
  const mock = progressOf(id);
  return {
    id,
    account: { name: parsed.data.account.name, email: parsed.data.account.email },
    company: parsed.data.company,
    whatsapp: mock.whatsapp,
    agent: mock.agent,
    agentSetup: mock.agentSetup,
    completedAt: mock.completedAt,
  };
}

/** Valores iniciais dos passos (o que já foi salvo ou o padrão do design). */
export async function getStepDefaults(
  draft: OnboardingDraft,
): Promise<{ company: CompanyStepInput; agent: AgentDraft }> {
  return {
    company: draft.company ?? defaultCompany(),
    agent: draft.agent ?? defaultAgent,
  };
}

export async function saveCompany(
  _id: string,
  input: CompanyStepInput,
): Promise<Result<null, "not_found" | "unavailable">> {
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

// ───────────── WhatsApp REAL (módulo Canais) · agente de teste ainda MOCK ─────────────

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
export async function startQrSession(id: string): Promise<Result<QrSession, "not_found" | "unavailable">> {
  const draft = progressOf(id);
  const channel = await ensureChannel("whatsapp_qr");
  if (!channel.ok) return channel;
  const started = await startChannelQr(channel.data.id);
  if (!started.ok) return fail("unavailable", "Não conseguimos gerar o QR Code agora. Tente de novo ou conecte depois, em Canais.");
  draft.channelId = channel.data.id;
  return ok({
    id: channel.data.id,
    payload: started.data.payload,
    expiresAt: started.data.expiresAt,
    status: started.data.status === "waiting" ? "pending" : started.data.status,
    phone: null,
  });
}

export async function getQrSession(id: string, _sessionId: string): Promise<Result<QrSession, "not_found">> {
  const draft = progressOf(id);
  if (!draft.channelId) return fail("not_found", "Código não encontrado. Gere um novo.");
  const current = await getChannelQr(draft.channelId);
  if (!current.ok) return fail("not_found", "Código não encontrado. Gere um novo.");
  const status = current.data.status === "waiting" ? "pending" : current.data.status;
  let phone: string | null = null;
  if (status === "connected") {
    phone = await phoneOf(draft.channelId);
    draft.whatsapp = { method: "qr_code", status: "connected", phone };
  }
  return ok({ id: draft.channelId, payload: current.data.payload, expiresAt: current.data.expiresAt, status, phone });
}

/** API oficial REAL: cria o canal e valida as credenciais com a Meta (módulo Canais). */
export async function connectOfficialApi(
  id: string,
  input: OfficialApiInput,
): Promise<Result<{ phone: string }, "not_found" | "invalid_credentials">> {
  const draft = progressOf(id);
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
  draft.channelId = channel.data.id;
  const phone = connected.data.address ?? "";
  draft.whatsapp = { method: "official_api", status: "connected", phone: connected.data.address };
  return ok({ phone });
}

export async function skipWhatsapp(id: string): Promise<Result<null, "not_found">> {
  await mockDelay(150);
  const draft = progressOf(id);
  if (draft.whatsapp?.status !== "connected")
    draft.whatsapp = { method: "qr_code", status: "skipped", phone: null };
  return ok(null);
}

/**
 * Conclui o cadastro. Com um rascunho de agente, cria (ou atualiza, se a pessoa voltou) o agente REAL, com o que a empresa
 * vende no conhecimento e ligado ao canal do WhatsApp (ativo só se o canal estiver conectado). Se isso falhar, o cadastro
 * NÃO é marcado como concluído: a empresa e o canal continuam salvos e a pessoa tenta de novo no mesmo passo.
 */
export async function completeOnboarding(
  id: string,
  agent: AgentDraft | null,
): Promise<Result<OnboardingDraft, "not_found" | "unavailable">> {
  const progressEntry = progressOf(id);
  const current = await getDraft(id);
  if (!current) return fail("not_found", expiredMessage);

  progressEntry.agent = agent; // guardado já: se der erro abaixo, o formulário volta preenchido
  if (agent) {
    if (!current.company) return fail("not_found", "Preencha os dados da empresa antes de criar o agente.");
    const setup = await setupOnboardingAgent({
      draft: agent,
      company: current.company,
      channelId: progressEntry.channelId,
      knownAgentId: progressEntry.agentId,
      onAgentId: (agentId) => {
        progressEntry.agentId = agentId;
      },
    });
    if (!setup.ok) return fail("unavailable", setup.message);
    progressEntry.agentSetup = setup.data;
  } else {
    progressEntry.agentSetup = null;
  }
  progressEntry.completedAt = new Date().toISOString();
  const full = await getDraft(id);
  if (!full) return fail("not_found", expiredMessage);
  return ok(full);
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
