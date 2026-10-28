import { z } from "zod";

export const faqItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
});
export type FaqItem = z.infer<typeof faqItemSchema>;

export const helpVideoSchema = z.object({
  id: z.string(),
  title: z.string(),
  durationSeconds: z.number().int(),
  /** null enquanto o vídeo não foi gravado (`[LINK]`). */
  url: z.string().nullable(),
});
export type HelpVideo = z.infer<typeof helpVideoSchema>;

export const helpCenterSchema = z.object({
  faq: z.array(faqItemSchema),
  videos: z.array(helpVideoSchema),
  support: z.object({
    hours: z.string(),
    whatsappUrl: z.string(),
    termsUrl: z.string(),
    privacyUrl: z.string(),
  }),
});
export type HelpCenter = z.infer<typeof helpCenterSchema>;

export const assistantMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  /** Trechos da documentação usados na resposta. */
  sources: z.array(z.object({ title: z.string(), href: z.string() })),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

export const askAssistantInputSchema = z.object({
  question: z.string().trim().min(3, "Escreva sua dúvida.").max(500, "Use até 500 caracteres."),
});

export const supportTicketInputSchema = z.object({
  subject: z.string().trim().min(3, "Informe o assunto.").max(120),
  message: z.string().trim().min(10, "Conte um pouco mais (pelo menos 10 letras).").max(4000),
});
export type SupportTicketInput = z.infer<typeof supportTicketInputSchema>;

export const supportTicketSchema = z.object({ id: z.string(), protocol: z.string() });
export type SupportTicket = z.infer<typeof supportTicketSchema>;
