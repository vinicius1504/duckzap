import { z } from "zod";
import { planSlugSchema } from "./session";

export const settingsTabSchema = z.enum(["empresa", "atendimento", "integracoes", "plano", "conta"]);
export type SettingsTab = z.infer<typeof settingsTabSchema>;

// ---------- Horário comercial (usado pela empresa e pelas equipes) ----------

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use o formato 08:00.");

/** 0 = domingo … 6 = sábado. */
export const weekdaySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export type Weekday = z.infer<typeof weekdaySchema>;

export const dayHoursSchema = z
  .object({ day: weekdaySchema, open: z.boolean(), start: timeSchema, end: timeSchema })
  .refine((d) => !d.open || d.start < d.end, { message: "O fim precisa ser depois do início.", path: ["end"] });
export type DayHours = z.infer<typeof dayHoursSchema>;

export const businessHoursSchema = z.array(dayHoursSchema).length(7);
export type BusinessHours = z.infer<typeof businessHoursSchema>;

// ---------- Empresa ----------

export const companySchema = z.object({
  name: z.string().trim().min(2, "Informe o nome da empresa.").max(80),
  segment: z.string().trim().max(60),
  phone: z.string().trim().max(20),
  email: z.union([z.email("E-mail inválido."), z.literal("")]),
  logoUrl: z.string().nullable(),
  timeZone: z.string(),
  businessHours: businessHoursSchema,
});
export type Company = z.infer<typeof companySchema>;
export const updateCompanyInputSchema = companySchema.omit({ logoUrl: true });
export type UpdateCompanyInput = z.infer<typeof updateCompanyInputSchema>;

// ---------- Atendimento ----------

export const serviceSettingsSchema = z.object({
  followUp: z.object({
    firstReminderHours: z.union([z.literal(2), z.literal(6), z.literal(24)]),
    secondReminderHours: z.union([z.literal(24), z.literal(48)]).nullable(),
    message: z.string().trim().min(1, "Escreva a mensagem de retomada.").max(500),
  }),
  inactivityClose: z.object({
    enabled: z.boolean(),
    days: z.union([z.literal(3), z.literal(7)]),
  }),
});
export type ServiceSettings = z.infer<typeof serviceSettingsSchema>;

// ---------- Integrações ----------

export const integrationStatusSchema = z.enum(["connected", "awaiting_authorization", "disconnected", "error"]);
export type IntegrationStatus = z.infer<typeof integrationStatusSchema>;

export const integrationsSchema = z.object({
  googleCalendar: z.object({
    status: integrationStatusSchema,
    calendarName: z.string().nullable(),
    lastSyncAt: z.iso.datetime().nullable(),
  }),
  instagram: z.object({ status: integrationStatusSchema, account: z.string().nullable() }),
  whatsappOfficial: z.object({
    status: integrationStatusSchema,
    /** Segredos nunca voltam inteiros (§5.2): só os últimos 4. */
    phoneNumberIdLast4: z.string().nullable(),
    accessTokenLast4: z.string().nullable(),
    webhookUrl: z.url(),
    verifyToken: z.string(),
  }),
});
export type Integrations = z.infer<typeof integrationsSchema>;

export const apiKeyScopeSchema = z.enum(["conversations:read", "messages:send", "contacts:read", "contacts:write"]);
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>;

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Prefixo visível (`dz_live_`) + últimos 4. O resto só existe como hash. */
  prefix: z.string(),
  last4: z.string().length(4),
  scopes: z.array(apiKeyScopeSchema),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(2, "Dê um nome para lembrar onde a chave é usada.").max(60),
  scopes: z.array(apiKeyScopeSchema).min(1, "Escolha pelo menos uma permissão."),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>;

/** Resposta da criação: o segredo completo aparece só esta vez. */
export const createdApiKeySchema = z.object({ apiKey: apiKeySchema, secret: z.string() });
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;

export const webhookEventSchema = z.enum([
  "message.received",
  "message.sent",
  "conversation.resolved",
  "contact.created",
  "appointment.created",
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const webhookSchema = z.object({
  id: z.string(),
  url: z.url(),
  events: z.array(webhookEventSchema),
  active: z.boolean(),
  /** Segredo de assinatura (HMAC-SHA256 no header `X-Duckzap-Signature`): só os últimos 4. */
  secretLast4: z.string().length(4),
  createdAt: z.iso.datetime(),
  lastDelivery: z
    .object({ at: z.iso.datetime(), statusCode: z.number().int(), ok: z.boolean() })
    .nullable(),
});
export type Webhook = z.infer<typeof webhookSchema>;

export const createWebhookInputSchema = z.object({
  url: z
    .url("Informe uma URL completa.")
    .refine((u) => u.startsWith("https://"), "Use uma URL com https://."),
  events: z.array(webhookEventSchema).min(1, "Escolha pelo menos um evento."),
});
export type CreateWebhookInput = z.infer<typeof createWebhookInputSchema>;

export const createdWebhookSchema = z.object({ webhook: webhookSchema, signingSecret: z.string() });
export type CreatedWebhook = z.infer<typeof createdWebhookSchema>;

export const webhookTestResultSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().int(),
  durationMs: z.number().int(),
});
export type WebhookTestResult = z.infer<typeof webhookTestResultSchema>;

// ---------- Plano e cobrança ----------

export const planSchema = z.object({
  slug: planSlugSchema,
  name: z.string(),
  /** null = preço ainda não definido (`[A DEFINIR]`). */
  priceCents: z.number().int().nullable(),
  /** null = ilimitado. */
  limits: z.object({
    channels: z.number().int().nullable(),
    users: z.number().int().nullable(),
    agents: z.number().int().nullable(),
  }),
  features: z.array(z.enum(["campaigns", "instagram", "copilot"])),
});
export type Plan = z.infer<typeof planSchema>;

export const invoiceSchema = z.object({
  id: z.string(),
  /** "2026-10" */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  dueDate: z.iso.date(),
  /** null = valor ainda não definido (`[VALOR]`). */
  amountCents: z.number().int().nullable(),
  status: z.enum(["paid", "open", "overdue"]),
  /** URL assinada do PDF; null enquanto a cobrança não estiver ligada. */
  pdfUrl: z.string().nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const billingSchema = z.object({
  plans: z.array(planSchema),
  currentPlan: planSlugSchema,
  renewsAt: z.iso.date(),
  paymentOk: z.boolean(),
  usage: z.object({ channels: z.number().int(), users: z.number().int(), agents: z.number().int() }),
  invoices: z.array(invoiceSchema),
});
export type Billing = z.infer<typeof billingSchema>;

// ---------- Minha conta ----------

export const accountSchema = z.object({
  name: z.string(),
  email: z.email(),
  phone: z.string(),
  twoFactor: z.object({ enabled: z.boolean(), enabledAt: z.iso.datetime().nullable() }),
  /** 2FA obrigatório para Proprietário e Administrador (§5.1). */
  twoFactorRequired: z.boolean(),
  notifications: z.object({ sound: z.boolean(), browser: z.boolean(), emailSummary: z.boolean() }),
});
export type Account = z.infer<typeof accountSchema>;

export const updateProfileInputSchema = z.object({
  name: z.string().trim().min(2, "Informe seu nome.").max(80),
  email: z.email("E-mail inválido."),
  phone: z.string().trim().max(20),
});
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

export const changePasswordInputSchema = z
  .object({
    currentPassword: z.string().min(1, "Informe a senha atual."),
    newPassword: z.string().min(10, "Use pelo menos 10 caracteres."),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, { message: "As senhas não são iguais.", path: ["confirmPassword"] });
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

export const notificationPrefsSchema = accountSchema.shape.notifications;
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const twoFactorSetupSchema = z.object({ secret: z.string(), otpauthUrl: z.string() });
export type TwoFactorSetup = z.infer<typeof twoFactorSetupSchema>;

export const totpCodeSchema = z.string().regex(/^\d{6}$/, "O código tem 6 números.");
