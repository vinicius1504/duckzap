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
});
export type HomeOverview = z.infer<typeof homeOverviewSchema>;
