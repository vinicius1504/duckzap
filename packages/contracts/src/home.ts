import { z } from "zod";

export const homePeriodSchema = z.enum(["today", "7d", "30d", "custom"]);
export type HomePeriod = z.infer<typeof homePeriodSchema>;

export const attentionItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["queue", "unanswered", "channel_down", "appointments_to_confirm"]),
  title: z.string(),
  detail: z.string(),
  href: z.string(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const taskPrioritySchema = z.enum(["urgent", "high", "medium", "low"]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

/**
 * Fatos da configuração da empresa para o cartão "Primeiros passos" do Início. Só sim/não, baratos de calcular;
 * a tela decide o que mostrar a cada papel (atendente não vê itens de administração).
 */
export const homeSetupSchema = z.object({
  /** Algum canal de WhatsApp (QR ou oficial) conectado agora. */
  whatsappConnected: z.boolean(),
  /** Algum agente de IA com status "ativo". */
  activeAgent: z.boolean(),
  /** Horário de atendimento gravado com pelo menos um dia aberto. */
  businessHours: z.boolean(),
  /** Pelo menos 1 produto no catálogo. */
  hasProduct: z.boolean(),
  /** Mais alguém na empresa (outra pessoa além de você ou um convite pendente). */
  teamInvited: z.boolean(),
  /** A empresa já tem pelo menos uma conversa (recebida ou de teste). */
  hasConversation: z.boolean(),
  /** A pessoa logada ativou a verificação em duas etapas. */
  twoFactorEnabled: z.boolean(),
});
export type HomeSetup = z.infer<typeof homeSetupSchema>;

export const homeOverviewSchema = z.object({
  attention: z.array(attentionItemSchema),
  kpis: z.object({
    openConversations: z.number().int(),
    newToday: z.number().int(),
    firstResponseSeconds: z.number().int(),
    handlingSeconds: z.number().int(),
    resolvedByAiPercent: z.number().min(0).max(100),
  }),
  conversationsPerDay: z.array(z.object({ date: z.iso.date(), count: z.number().int() })),
  funnel: z.array(z.object({ stage: z.string(), percent: z.number() })),
  weeklyConversion: z.array(z.object({ label: z.string(), percent: z.number() })),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      dueLabel: z.string(),
      assignee: z.string(),
      priority: taskPrioritySchema,
      done: z.boolean(),
    }),
  ),
  conversationsByAgent: z.array(z.object({ name: z.string(), count: z.number().int(), isAi: z.boolean() })),
  /** Opcional: uma API antiga não manda e o cartão "Primeiros passos" simplesmente não aparece. */
  setup: homeSetupSchema.optional(),
});
export type HomeOverview = z.infer<typeof homeOverviewSchema>;
