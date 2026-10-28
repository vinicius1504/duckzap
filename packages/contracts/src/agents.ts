import { z } from "zod";
import { appointmentTypeSchema as agendaAppointmentTypeSchema } from "./appointments";

// Agentes de IA (§1.1 módulo 6, §4). Cada agente é configuração versionada (agent_versions), não código.

/** "scheduling" continua aceito (agentes já salvos), mas a UI não o oferece mais: agendar é função do sistema, vale para qualquer agente. */
export const agentJobSchema = z.enum(["support", "follow_up", "scheduling", "instagram_dm", "comments"]);
export type AgentJob = z.infer<typeof agentJobSchema>;

/** Trabalhos que dependem do Instagram (plano Escala, §1.2). */
export const INSTAGRAM_JOBS: readonly AgentJob[] = ["instagram_dm", "comments"];

export const agentStatusSchema = z.enum(["active", "paused", "inactive"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentToneSchema = z.enum(["friendly", "formal", "direct"]);
export type AgentTone = z.infer<typeof agentToneSchema>;

/** Tools permitidas (§4.2). `request_human` é sempre ligada. */
export const agentToolSchema = z.enum([
  "search_knowledge",
  "list_available_slots",
  "book_appointment",
  "reschedule_appointment",
  "update_contact_fields",
  "add_tag",
  "request_human",
  "schedule_followup",
]);
export type AgentTool = z.infer<typeof agentToolSchema>;

export const agentChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["whatsapp_qr", "whatsapp_official", "instagram"]),
});
export type AgentChannel = z.infer<typeof agentChannelSchema>;

export const knowledgeDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["pdf", "docx", "txt"]),
  sizeBytes: z.number().int().min(0),
  pages: z.number().int().nullable(),
  status: z.enum(["processing", "ready", "failed"]),
  error: z.string().nullable(),
  uploadedAt: z.iso.datetime(),
});
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_EXTENSIONS = ["pdf", "docx", "txt"] as const;

export const followUpStepSchema = z.object({
  id: z.string(),
  delayMinutes: z.number().int().min(15).max(60 * 24 * 14),
  /** "ai": a IA escreve com base na conversa; "fixed": texto fixo. */
  mode: z.enum(["ai", "fixed"]),
  content: z.string().max(500),
});
export type FollowUpStep = z.infer<typeof followUpStepSchema>;

/** Tipo de atendimento visto pelos Agentes: o mesmo schema da Agenda (uma só definição), sem o campo `active`. */
export const appointmentTypeSchema = agendaAppointmentTypeSchema.pick({ id: true, name: true, durationMinutes: true, staffOnly: true });
export type AppointmentType = z.infer<typeof appointmentTypeSchema>;

/** Exemplo de resposta (few-shot): o que o cliente escreve e como o agente responde. Referência de estilo, não texto literal. */
export const MAX_AGENT_EXAMPLES = 12;
export const MAX_EXAMPLE_CHARS = 400;
export const agentExampleSchema = z.object({
  customer: z.string().trim().min(1).max(MAX_EXAMPLE_CHARS),
  agent: z.string().trim().min(1).max(MAX_EXAMPLE_CHARS),
});
export type AgentExample = z.infer<typeof agentExampleSchema>;

// ---------- dados do gerador (limites compartilhados entre a entrada do gerador e o que a config guarda) ----------

/**
 * Finalidade do agente: define a postura base do texto gerado. "scheduling" continua aceito (dados salvos e chamadas antigas),
 * mas a UI não oferece mais "Agendamento": agendar é automático para qualquer agente quando a empresa tem tipos ativos na Agenda.
 */
export const agentGeneratorPurposeSchema = z.enum(["reception", "sales", "support", "scheduling"]);
export type AgentGeneratorPurpose = z.infer<typeof agentGeneratorPurposeSchema>;

export const GENERATOR_COMPANY_TEXT_MAX = 20_000;

const optionalText = (max: number) => z.string().trim().max(max).optional();

/** Campos opcionais curtos do formulário do gerador (uma só definição: entrada do gerador e `config.generator`). */
const generatorOptionalFields = {
  sells: optionalText(1500),
  doesNotSell: optionalText(800),
  paymentMethods: optionalText(500),
  hours: optionalText(400),
  location: optionalText(400),
  /** Como funcionam orçamentos/propostas. */
  budgetProcess: optionalText(1000),
  askBeforeHandoff: optionalText(600),
  handoffRules: optionalText(1000),
  restrictions: optionalText(1000),
  customInstructions: optionalText(2000),
};

/**
 * Formulário do gerador guardado na config do agente (opcional: configs antigas não têm). Serve só para a tela reabrir o
 * formulário preenchido: NUNCA vai para o prompt do modelo (o runtime só lê os campos gerados). Nome e tom ficam em
 * `name` e `profile.tone`.
 */
export const agentGeneratorStoredSchema = z.object({
  purpose: agentGeneratorPurposeSchema,
  companyText: z.string().max(GENERATOR_COMPANY_TEXT_MAX),
  ...generatorOptionalFields,
});
export type AgentGeneratorStored = z.infer<typeof agentGeneratorStoredSchema>;

/** Tudo que é editável e versionado. Salvar cria uma versão nova. */
export const agentConfigSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome para o agente.").max(60),
  profile: z.object({
    description: z.string().max(200),
    tone: agentToneSchema,
    companySummary: z.string().max(2000),
  }),
  knowledge: z.object({
    productsAndServices: z.string().max(5000),
    faq: z.string().max(5000),
    /**
     * "Informações da empresa": UM texto com tudo que o agente precisa saber (sobre a empresa, o que oferece, pagamento, horário,
     * perguntas frequentes…). Opcional: agentes antigos usam `productsAndServices`/`faq` (continuam valendo e entrando no prompt).
     */
    companyInfo: z.string().max(12000).optional(),
    /**
     * Exemplos de resposta. Opcional (ausente = nenhum): configs salvas antes deste campo continuam válidas e telas/mocks que
     * montam a config sem ele seguem compilando. Quem lê usa `examples ?? []`.
     */
    examples: z.array(agentExampleSchema).max(MAX_AGENT_EXAMPLES).optional(),
  }),
  behavior: z.object({
    respondWhen: z.enum(["always", "outside_hours", "no_reply_5min"]),
    handoffOnRequest: z.boolean(),
    handoffOnComplaint: z.boolean(),
    handoffOnUnknown: z.boolean(),
    /** 0 = mais preciso, 10 = mais criativo. */
    creativity: z.number().int().min(0).max(10),
    maxConsecutiveMessages: z.number().int().min(1).max(20),
  }),
  followUp: z.object({
    enabled: z.boolean(),
    steps: z.array(followUpStepSchema).max(5),
    respectBusinessHours: z.boolean(),
    stopOnReply: z.boolean(),
  }),
  /**
   * LEGADO, ignorado pelo runtime: a agenda é função do sistema. Qualquer agente vê horários, marca e remarca quando a empresa tem
   * ao menos um tipo de atendimento ativo (e que não seja "só a equipe marca"); sem tipo ativo, não há ferramentas de agenda.
   * Segue no schema só para não invalidar configs salvas; nada é apagado nem migrado.
   */
  scheduling: z.object({
    canBook: z.boolean(),
    appointmentTypeIds: z.array(z.string()),
  }),
  advanced: z.object({
    prompt: z.string().max(8000),
    /** `list_available_slots`, `book_appointment` e `reschedule_appointment` aqui são LEGADO e ignorados (a agenda vem da empresa). */
    tools: z.array(agentToolSchema),
    /** "Restrições": o que a IA NUNCA deve fazer (regra do negócio; não substitui as regras fixas de segurança). Opcional. */
    restrictions: z.string().max(3000).optional(),
  }),
  /** Formulário do gerador de perfil (para reabrir preenchido). Opcional; não entra no prompt do agente. */
  generator: agentGeneratorStoredSchema.optional(),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const agentSchema = z.object({
  id: z.string(),
  job: agentJobSchema,
  status: agentStatusSchema,
  isDefault: z.boolean(),
  teams: z.array(z.string()),
  channels: z.array(agentChannelSchema),
  config: agentConfigSchema,
  documents: z.array(knowledgeDocumentSchema),
  currentVersion: z.number().int().min(1),
  /** Motivo de estar pausado pelo sistema (ex.: recurso fora do plano). */
  pausedReason: z.enum(["plan_feature", "manual"]).nullable(),
  stats: z.object({ conversationsLast7d: z.number().int(), handoffRatePercent: z.number().min(0).max(100) }),
  updatedAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

export const agentVersionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  number: z.number().int(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  summary: z.string(),
  config: agentConfigSchema,
});
export type AgentVersion = z.infer<typeof agentVersionSchema>;

export const copilotOverviewSchema = z.object({
  enabled: z.boolean(),
  teams: z.array(z.string()),
  feedback: z.object({ useful: z.number().int(), bad: z.number().int() }),
  recentBad: z.array(z.object({ id: z.string(), suggestion: z.string(), reason: z.string().nullable(), at: z.iso.datetime() })),
});
export type CopilotOverview = z.infer<typeof copilotOverviewSchema>;

export const createAgentInputSchema = z.object({
  name: z.string().trim().min(1, "Dê um nome para o agente.").max(60),
  job: agentJobSchema,
  channelIds: z.array(z.string()),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

// ---------- simulador (dry-run, §4.3) ----------

export const simulatorMessageSchema = z.object({
  role: z.enum(["customer", "agent"]),
  text: z.string().trim().min(1).max(1000),
});
export type SimulatorMessage = z.infer<typeof simulatorMessageSchema>;

export const simulatorToolCallSchema = z.object({
  tool: agentToolSchema,
  args: z.record(z.string(), z.string()),
  result: z.string(),
});
export type SimulatorToolCall = z.infer<typeof simulatorToolCallSchema>;

export const simulatorReplySchema = z.object({
  /** Respostas do agente (pode ser mais de uma, até o limite de mensagens seguidas). */
  messages: z.array(z.string()),
  toolCalls: z.array(simulatorToolCallSchema),
  handoff: z.object({ reason: z.string() }).nullable(),
  /** Intenção que o roteador identificou. */
  intent: z.enum(["question", "schedule", "buy", "complaint", "human", "spam", "opt_out"]),
});
export type SimulatorReply = z.infer<typeof simulatorReplySchema>;

export const agentTabSchema = z.enum(["perfil", "conhecimento", "comportamento", "follow-up", "agenda", "avancado"]);
export type AgentTab = z.infer<typeof agentTabSchema>;

// ---------- entradas/saídas das rotas (back real) ----------

export const agentStatusInputSchema = z.object({ status: agentStatusSchema });
export const rollbackInputSchema = z.object({ versionId: z.string().min(1).max(64) });

/** Upload de conhecimento (fase atual): metadados + texto já extraído (TXT). PDF/DOCX dependem de extrator no servidor. */
export const uploadDocumentInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().min(0).max(MAX_DOCUMENT_BYTES),
  text: z.string().max(400_000).optional(),
});
export type UploadDocumentInput = z.infer<typeof uploadDocumentInputSchema>;

export const simulateInputSchema = z.object({
  config: agentConfigSchema,
  history: z.array(simulatorMessageSchema).min(1).max(40),
});
export type SimulateInput = z.infer<typeof simulateInputSchema>;

export const copilotToggleInputSchema = z.object({ enabled: z.boolean() });

export const copilotFeedbackInputSchema = z.object({
  agentId: z.string().max(64).optional(),
  conversationId: z.string().min(1).max(64),
  messageId: z.string().max(64).optional(),
  verdict: z.enum(["useful", "bad"]),
  suggestion: z.string().min(1).max(2000),
  reason: z.string().max(300).optional(),
});
export type CopilotFeedbackInput = z.infer<typeof copilotFeedbackInputSchema>;

export const agentPlanUsageSchema = z.object({ agents: z.number().int(), maxAgents: z.number().int().nullable() });
export type AgentPlanUsage = z.infer<typeof agentPlanUsageSchema>;

// ---------- gerador de perfil do agente (a partir dos dados da empresa) ----------

export const AGENT_GENERATOR_PURPOSE_LABELS: Record<AgentGeneratorPurpose, string> = {
  reception: "Recepção e triagem",
  sales: "SDR / Vendas",
  support: "Suporte nível 1",
  scheduling: "Agendamento",
};

export const agentGeneratorInputSchema = z
  .object({
    purpose: agentGeneratorPurposeSchema,
    agentName: z.string().trim().min(1, "Dê um nome para o agente.").max(60),
    tone: agentToneSchema,
    /** Texto colado sobre a empresa (site, "quem somos", catálogo…). É dado de terceiros para o gerador, nunca instrução. */
    companyText: z.string().trim().max(GENERATOR_COMPANY_TEXT_MAX, "O texto da empresa passou do limite de 20 mil caracteres.").default(""),
    ...generatorOptionalFields,
  })
  .refine((v) => v.companyText.length >= 20 || (v.sells ?? "").length >= 3, {
    message: "Conte um pouco sobre a empresa: cole um texto sobre ela ou descreva o que ela vende.",
    path: ["companyText"],
  });
export type AgentGeneratorInput = z.input<typeof agentGeneratorInputSchema>;
export type AgentGeneratorParsedInput = z.output<typeof agentGeneratorInputSchema>;

/** Campos que o gerador pode apontar como ausentes (só os que o dono consegue completar com uma frase). */
export const GENERATOR_MISSING_FIELD_KEYS = ["sells", "doesNotSell", "paymentMethods", "hours", "location", "budgetProcess", "handoffRules"] as const;
export const generatorMissingFieldSchema = z.enum(GENERATOR_MISSING_FIELD_KEYS);
export type GeneratorMissingField = z.infer<typeof generatorMissingFieldSchema>;

export const GENERATOR_MIN_EXAMPLES = 8;
export const GENERATOR_MAX_EXAMPLES = 10;

/** Conteúdo gerado: cabe nos campos do agente (mesmos limites de `agentConfigSchema`); o dono revisa e salva pelas rotas de agentes. */
export const agentGeneratorOutputSchema = z.object({
  /** → `profile.description` */
  description: z.string().trim().min(1).max(200),
  /** → `advanced.prompt` ("Objetivos e instruções": papel, condução, saudação, despedida, quando transferir; sem restrições) */
  instructions: z.string().trim().min(1).max(8000),
  /** → `profile.companySummary` (resumo curto, 1 a 3 frases) */
  companySummary: z.string().trim().min(1).max(2000),
  /** → `knowledge.companyInfo` ("Informações da empresa": seções em texto simples, com perguntas frequentes) */
  companyInfo: z.string().trim().max(12000),
  /** → `advanced.restrictions` ("Restrições": o que a IA nunca deve fazer) */
  restrictions: z.string().trim().max(3000).default(""),
  /** Legado: o gerador novo não escreve mais estes dois (vêm ""); aceitos por compatibilidade. */
  productsAndServices: z.string().trim().max(5000).default(""),
  faq: z.string().trim().max(5000).default(""),
  /** → `knowledge.examples` */
  examples: z.array(agentExampleSchema).min(GENERATOR_MIN_EXAMPLES).max(GENERATOR_MAX_EXAMPLES),
  /** Informações importantes que faltaram nos dados (o dono deve preencher). */
  warnings: z.array(z.string().trim().min(1).max(300)).max(20),
  /**
   * Itens estruturados que faltaram em TODOS os dados (a tela mostra um campo para cada um). Ausente = sem lista.
   * Nunca inclui o que o formulário já trazia preenchido.
   */
  missingFields: z.array(generatorMissingFieldSchema).max(GENERATOR_MISSING_FIELD_KEYS.length).optional(),
});
export type AgentGeneratorOutput = z.infer<typeof agentGeneratorOutputSchema>;

// ---------- sugestões para a tela do gerador (só constantes; não validam o input) ----------

/** Restrições comuns que o dono pode marcar com um clique. */
export const AGENT_RESTRICTION_SUGGESTIONS: readonly string[] = [
  "Nunca mencionar preços",
  "Não usar gírias nem abreviações",
  "Não usar emojis",
  "Não fazer suposições sobre o cliente",
  "Não citar concorrentes",
  "Sem piadas ou sarcasmo",
  "Não pedir dados sensíveis, como senha ou dados bancários",
  "Não dar informação médica ou jurídica",
  "Não discutir religião, política nem futebol",
];

/** Objetivos comuns que o dono pode marcar com um clique. */
export const AGENT_OBJECTIVE_SUGGESTIONS: readonly string[] = [
  "Ser sempre cordial e prestativo",
  "Perguntar o nome do cliente no início da conversa",
  "Agendar reuniões com clientes interessados",
  "Usar linguagem formal",
];
