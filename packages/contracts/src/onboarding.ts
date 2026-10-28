import { z } from "zod";

// Onboarding (P4): criação da conta + 3 passos (empresa, WhatsApp, primeiro agente).

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: "Use o formato 00:00." });

export const signUpSchema = z.object({
  name: z.string().trim().min(2, { error: "Informe seu nome." }).max(120),
  email: z.email({ error: "Informe um e-mail válido." }).trim().toLowerCase(),
  password: z
    .string()
    .min(8, { error: "Use pelo menos 8 caracteres." })
    .max(128, { error: "Use no máximo 128 caracteres." })
    .regex(/[A-Za-z]/, { error: "Use pelo menos uma letra." })
    .regex(/\d/, { error: "Use pelo menos um número." }),
  acceptTerms: z.boolean().refine((v) => v, { error: "Aceite os termos para continuar." }),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof weekdaySchema>;

export const businessHourSchema = z
  .object({
    day: weekdaySchema,
    open: z.boolean(),
    opensAt: z.union([time, z.literal("")]),
    closesAt: z.union([time, z.literal("")]),
  })
  .refine((h) => !h.open || (h.opensAt !== "" && h.closesAt !== "" && h.opensAt < h.closesAt), {
    error: "O horário de fechar precisa ser depois do de abrir.",
    path: ["closesAt"],
  });
export type BusinessHour = z.infer<typeof businessHourSchema>;

export const companyStepSchema = z.object({
  companyName: z.string().trim().min(2, { error: "Informe o nome da empresa." }).max(120),
  businessHours: z
    .array(businessHourSchema)
    .length(7)
    .refine((days) => days.some((d) => d.open), { error: "Marque pelo menos um dia aberto." }),
  /**
   * Legado: o cadastro não pede mais boas-vindas (novas contas são "Somente IA": o agente cumprimenta).
   * Segue aceito e opcional (padrão vazio) por compatibilidade com o banco e com clientes antigos.
   */
  welcomeMessage: z.string().trim().max(1000, { error: "Use no máximo 1000 caracteres." }).default(""),
});
export type CompanyStepInput = z.infer<typeof companyStepSchema>;
/** Entrada do formulário (antes dos padrões do Zod): `welcomeMessage` pode faltar. */
export type CompanyStepFormValues = z.input<typeof companyStepSchema>;

export const connectionMethodSchema = z.enum(["qr_code", "official_api"]);
export type ConnectionMethod = z.infer<typeof connectionMethodSchema>;

export const qrSessionStatusSchema = z.enum(["pending", "connected", "expired"]);
export type QrSessionStatus = z.infer<typeof qrSessionStatusSchema>;

export const qrSessionSchema = z.object({
  id: z.string(),
  /** Conteúdo do QR Code (o front só desenha). */
  payload: z.string(),
  expiresAt: z.iso.datetime(),
  status: qrSessionStatusSchema,
  /** Número conectado, em E.164, quando `status = connected`. */
  phone: z.string().nullable(),
});
export type QrSession = z.infer<typeof qrSessionSchema>;

export const officialApiSchema = z.object({
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/, { error: "Use só números (ID do número na Meta)." }),
  businessAccountId: z
    .string()
    .trim()
    .regex(/^\d{6,20}$/, { error: "Use só números (ID da conta WhatsApp Business)." }),
  accessToken: z.string().trim().min(20, { error: "Cole o token de acesso permanente." }).max(512),
});
export type OfficialApiInput = z.infer<typeof officialApiSchema>;

export const agentGoalSchema = z.enum(["support", "sales", "scheduling"]);
export type AgentGoal = z.infer<typeof agentGoalSchema>;

export const agentToneSchema = z.enum(["friendly", "formal", "direct"]);
export type AgentTone = z.infer<typeof agentToneSchema>;

export const agentDraftSchema = z.object({
  goal: agentGoalSchema,
  tone: agentToneSchema,
  offering: z.string().trim().min(3, { error: "Conte o que a empresa vende ou faz." }).max(1000),
  rules: z.string().trim().max(1000),
  handoffWhen: z.string().trim().max(1000),
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

export const previewMessageSchema = z.object({
  from: z.enum(["customer", "agent"]),
  text: z.string().max(1000),
});
export type PreviewMessage = z.infer<typeof previewMessageSchema>;

/** O que o cadastro criou de verdade no módulo Agentes ao concluir (a tela final conta o que existe e o que falta). */
export const agentSetupSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  /** Respondendo clientes agora. Só fica ativo se o agente está ligado a um canal CONECTADO. */
  active: z.boolean(),
  /** Existe um canal criado no cadastro e o agente está ligado a ele. */
  channelLinked: z.boolean(),
  /** O canal ligado está conectado ao WhatsApp. */
  channelConnected: z.boolean(),
  /** Objetivo "Agendar" sem tipos de atendimento cadastrados na Agenda: o agente ainda não marca horários. */
  needsAppointmentTypes: z.boolean(),
  /** Motivo, quando ligar o agente foi recusado (ex.: limite do plano). */
  activationError: z.string().nullable(),
});
export type AgentSetup = z.infer<typeof agentSetupSchema>;

export const onboardingDraftSchema = z.object({
  id: z.string(),
  account: z.object({ name: z.string(), email: z.email() }),
  company: companyStepSchema.nullable(),
  whatsapp: z
    .object({
      method: connectionMethodSchema,
      status: z.enum(["connected", "skipped"]),
      phone: z.string().nullable(),
    })
    .nullable(),
  /** null depois de concluir = agente pulado. */
  agent: agentDraftSchema.nullable(),
  /** O agente real criado ao concluir (null = agente pulado ou ainda não concluído). */
  agentSetup: agentSetupSchema.nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>;

export const onboardingStepSchema = z.enum(["empresa", "whatsapp", "agente", "pronto"]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;
