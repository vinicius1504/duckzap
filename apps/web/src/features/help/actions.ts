"use server";

import { askAssistantInputSchema, supportTicketInputSchema, type AssistantMessage, type SupportTicket } from "@duckzap/contracts/help";
import { requireSession } from "@/features/auth/session";
import { askHelpAssistant, createSupportTicket, restartProductTour } from "./api";

export type ActionResult<T> = { ok: true; data: T } | { ok?: false; error: string };

export async function askAssistantAction(question: string): Promise<ActionResult<AssistantMessage>> {
  await requireSession();
  const parsed = askAssistantInputSchema.safeParse({ question });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Escreva sua dúvida." };
  const result = await askHelpAssistant(parsed.data.question);
  return result.ok ? result : { ok: false, error: result.message };
}

export async function createSupportTicketAction(input: { subject: string; message: string }): Promise<ActionResult<SupportTicket>> {
  const session = await requireSession();
  const parsed = supportTicketInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Confira os campos." };
  const result = await createSupportTicket(session.user.id, parsed.data);
  return result.ok ? result : { ok: false, error: result.message };
}

export async function restartTourAction(): Promise<ActionResult<null>> {
  const session = await requireSession();
  const result = await restartProductTour(session.user.id);
  return result.ok ? result : { ok: false, error: result.message };
}
