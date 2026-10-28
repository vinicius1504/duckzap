import { z } from "zod";
import type { LLMProvider, TokenUsage } from "../llm";

/**
 * Tipos do runtime dos agentes (INSTRUCTIONS §4). Este diretório é puro: sem banco, sem Hono, sem filas.
 * Tudo que toca o mundo (conhecimento, agenda, clientes, conversa) entra por PORTAS (interfaces) abaixo,
 * implementadas pelos módulos reais (Clientes/Agenda/Conversas) ou pelos fakes em memória (`fakes.ts`).
 */

export const INTENTS = ["question", "schedule", "buy", "complaint", "human", "spam", "opt_out"] as const;
export type Intent = (typeof INTENTS)[number];

export const TOOL_NAMES = [
  "search_knowledge",
  "list_available_slots",
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "update_contact_fields",
  "add_tag",
  "request_human",
  "schedule_followup",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Subconjunto da configuração versionada do agente que o runtime usa (o `AgentConfig` do contrato é atribuível a ele). */
export const agentRuntimeConfigSchema = z.object({
  name: z.string(),
  profile: z.object({
    description: z.string(),
    tone: z.enum(["friendly", "formal", "direct"]),
    companySummary: z.string(),
  }),
  knowledge: z.object({
    productsAndServices: z.string(),
    faq: z.string(),
    /** "Informações da empresa" (espelha `knowledge.companyInfo` do contrato). Opcional: agentes antigos usam productsAndServices/faq. */
    companyInfo: z.string().optional(),
    /** Exemplos de resposta (few-shot). Opcional: configs antigas não têm. Espelha `knowledge.examples` do contrato. */
    examples: z.array(z.object({ customer: z.string(), agent: z.string() })).optional(),
  }),
  behavior: z.object({
    respondWhen: z.enum(["always", "outside_hours", "no_reply_5min"]),
    handoffOnRequest: z.boolean(),
    handoffOnComplaint: z.boolean(),
    handoffOnUnknown: z.boolean(),
    creativity: z.number().int().min(0).max(10),
    maxConsecutiveMessages: z.number().int().min(1).max(20),
  }),
  followUp: z.object({
    enabled: z.boolean(),
    steps: z.array(
      z.object({ id: z.string(), delayMinutes: z.number().int(), mode: z.enum(["ai", "fixed"]), content: z.string() }),
    ),
    respectBusinessHours: z.boolean(),
  }),
  scheduling: z.object({ canBook: z.boolean(), appointmentTypeIds: z.array(z.string()) }),
  advanced: z.object({
    prompt: z.string(),
    tools: z.array(z.string()),
    /** "Restrições" do negócio (espelha `advanced.restrictions`). Opcional. */
    restrictions: z.string().optional(),
  }),
  /**
   * Formulário do gerador de perfil guardado na config (espelha `config.generator` do contrato). O runtime NUNCA o lê:
   * não entra no prompt do modelo (`buildSystemPrompt` só usa os campos gerados).
   */
  generator: z
    .object({
      purpose: z.enum(["reception", "sales", "support", "scheduling"]),
      companyText: z.string(),
      sells: z.string().optional(),
      doesNotSell: z.string().optional(),
      paymentMethods: z.string().optional(),
      hours: z.string().optional(),
      location: z.string().optional(),
      budgetProcess: z.string().optional(),
      askBeforeHandoff: z.string().optional(),
      handoffRules: z.string().optional(),
      restrictions: z.string().optional(),
      customInstructions: z.string().optional(),
    })
    .optional(),
});
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;

// ---------- escopo (definido pelo SERVIDOR; o modelo nunca escolhe nada disto) ----------

export type Scope = { organizationId: string; conversationId: string; contactId: string; agentId: string };

// ---------- máquina de estados ----------

export const CONVERSATION_STATES = ["ai_active", "waiting_customer", "handoff_requested", "human_active", "resolved"] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

// ---------- portas ----------

export class PortError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict" | "unavailable" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "PortError";
  }
}

export type KnowledgeHit = { id: string; documentName: string | null; text: string; score: number };
export interface KnowledgePort {
  search(scope: Scope, query: string, limit: number): Promise<KnowledgeHit[]>;
}

export type AppointmentTypeInfo = { id: string; name: string; durationMinutes: number; staffOnly: boolean };
export type Slot = { id: string; typeId: string; startsAt: string };
export type AppointmentInfo = { id: string; typeId: string; startsAt: string; status: "pending" | "confirmed" | "canceled" };
export interface AgendaPort {
  getType(scope: Scope, typeId: string): Promise<AppointmentTypeInfo | null>;
  listAvailableSlots(scope: Scope, query: { typeId: string; from: string; to: string }): Promise<Slot[]>;
  /** Só os agendamentos DO contato do escopo. */
  listContactAppointments(scope: Scope): Promise<AppointmentInfo[]>;
  /** Marca o agendamento já CONFIRMADO (o cliente combinou o horário na conversa); se a confirmação não passar, devolve `pending`. */
  bookAppointment(scope: Scope, input: { slotId: string; typeId: string }): Promise<AppointmentInfo>;
  /** Implementação DEVE recusar (`not_found`) agendamento que não seja do contato do escopo. */
  rescheduleAppointment(scope: Scope, input: { appointmentId: string; slotId: string }): Promise<AppointmentInfo>;
  cancelAppointment(scope: Scope, input: { appointmentId: string }): Promise<void>;
}

export type ContactInfo = { name: string | null; email: string | null; phone: string | null; tags: string[] };
export interface ContactsPort {
  getContact(scope: Scope): Promise<ContactInfo | null>;
  updateFields(scope: Scope, fields: { name?: string; email?: string }): Promise<void>;
  addTag(scope: Scope, tag: string): Promise<void>;
}

export interface ConversationsPort {
  requestHuman(scope: Scope, reason: string): Promise<void>;
  scheduleFollowup(scope: Scope, input: { stepId: string; runAt: Date }): Promise<void>;
  markOptOut(scope: Scope): Promise<void>;
}

export type AgentPorts = {
  knowledge: KnowledgePort;
  agenda: AgendaPort;
  contacts: ContactsPort;
  conversations: ConversationsPort;
};

/** Embeddings (Anthropic não oferece): porta para quando houver provedor. Retrieval funciona sem ela (texto/trigram). */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

// ---------- horário comercial ----------

/** `days[0]` = domingo … `days[6]` = sábado; `null` = fechado. Formato "HH:MM". */
export type BusinessHours = { timeZone: string; days: ([string, string] | null)[] };

// ---------- turno ----------

export type ChatMessage = { role: "customer" | "agent" | "human"; text: string };

export type HandoffKind =
  | "customer_request"
  | "complaint"
  | "urgency"
  | "unknown_knowledge"
  | "low_confidence"
  | "tool_failures"
  | "guardrail"
  | "model_request"
  | "budget"
  | "message_limit"
  | "llm_error";

export type UsageEvent = { purpose: string; provider: string; model: string; usage: TokenUsage };

export type ToolTrace = { tool: ToolName; args: Record<string, string>; result: string; ok: boolean };

export type TurnInput = {
  scope: Scope;
  /** live = envia; copilot = vira sugestão (sem efeitos); simulator = dry-run em dados fictícios. */
  mode: "live" | "copilot" | "simulator";
  config: AgentRuntimeConfig;
  state: ConversationState;
  /** Do mais antigo ao mais novo; as últimas mensagens do cliente (rajada) já agregadas ao final. */
  history: ChatMessage[];
  llm: LLMProvider;
  ports: AgentPorts;
  now?: Date;
  /** Fuso da empresa (IANA): é nele que a IA fala data e hora com o cliente. Padrão: o do horário comercial, ou São Paulo. */
  timeZone?: string;
  businessHours?: BusinessHours;
  /** Domínios que o agente pode citar (além dos que aparecem no conhecimento do agente). */
  urlAllowlist?: string[];
  /** Etiquetas que `add_tag` pode usar (etapas do funil). */
  allowedTags?: string[];
  /** Quantas mensagens do agente já foram enviadas seguidas sem resposta do cliente. */
  consecutiveAgentMessages?: number;
  conversationSummary?: string;
  /** Minutos desde a última mensagem do cliente sem resposta de pessoa (para `no_reply_5min`). */
  minutesWaiting?: number;
  budget?: { remainingTokens: number };
  /** Delimitador anti-injeção; aleatório por turno em produção, fixo nos testes. */
  nonce?: string;
  onUsage?: (event: UsageEvent) => void | Promise<void>;
  /** Telefone/e-mail do próprio cliente (permitidos na resposta). */
  ownContactValues?: string[];
  /**
   * Novas tentativas DENTRO do turno quando o provedor falha de forma passageira (`LlmError.retryable`:
   * limite de uso, sobrecarga, timeout). Padrão: 2 tentativas extras, após ~1,5 s e ~4 s (com jitter).
   * `sleep` é injetável (testes não esperam de verdade); `signal` interrompe a espera.
   */
  retry?: LlmRetryOptions;
  /**
   * Ao vivo, falha passageira do provedor que persiste após as novas tentativas vira `skipped = "llm_unavailable"` (sem handoff,
   * sem mensagem) para quem chamou tentar o turno de novo depois. `false` = já esgotou os adiamentos: passa para a equipe (`llm_error`).
   * Padrão: true. Copiloto e simulador nunca adiam.
   */
  deferLlmFailure?: boolean;
};

export type LlmRetryOptions = {
  /** Esperas antes de cada nova tentativa, em ms (o tamanho da lista = número de tentativas extras). `[]` desliga. */
  delaysMs?: number[];
  /** Fração de variação aleatória sobre cada espera (padrão 0,25 = ±25%). */
  jitter?: number;
  /** Fonte de aleatoriedade (0 a 1); padrão `Math.random`. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

/** `TurnResult.skipped` quando o provedor de IA falhou de forma passageira mesmo após as novas tentativas: nada foi enviado, sem handoff. */
export const SKIP_LLM_UNAVAILABLE = "llm_unavailable";

export type TurnResult = {
  /** O que seria enviado (ou sugerido, no copiloto). Vazio quando a IA não responde. */
  messages: string[];
  intent: Intent | null;
  handoff: { kind: HandoffKind; reason: string } | null;
  toolCalls: ToolTrace[];
  /** Motivo de a IA não ter respondido (estado, horário, spam, orçamento…). `llm_unavailable` = falha passageira do provedor: quem chamou deve tentar o turno de novo mais tarde. */
  skipped: string | null;
  optOut: boolean;
  transitions: import("./state-machine").TransitionRecord[];
  state: ConversationState;
  /** Bloqueios de guardrail aplicados (para auditoria/avaliação). */
  blocked: string[];
  /** Sinais de auditoria (ex.: suspeita de injeção). */
  flags: string[];
  usage: { inputTokens: number; outputTokens: number };
};
