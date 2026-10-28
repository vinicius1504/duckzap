"use server";

import {
  agentDraftSchema,
  companyStepSchema,
  officialApiSchema,
  previewMessageSchema,
  signUpSchema,
  type AgentDraft,
  type CompanyStepInput,
  type OfficialApiInput,
  type PreviewMessage,
  type QrSession,
  type SignUpInput,
} from "@duckzap/contracts/onboarding";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  completeOnboarding,
  connectOfficialApi,
  createSignUp,
  getQrSession,
  saveCompany,
  simulateAgentReply,
  skipWhatsapp,
  startQrSession,
} from "./api";
import { getCurrentDraft, ONBOARDING_COOKIE } from "./draft";

// Server Actions finas: cadastro em andamento (cookie) → validação → api.ts → revalidar.

type ActionResult = { error: string } | null;

const expired = { error: "Seu cadastro expirou. Recarregue a página para começar de novo." };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Confira os dados e tente de novo.";
}

async function currentId() {
  return (await getCurrentDraft())?.id ?? null;
}

export async function signUpAction(input: SignUpInput): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await createSignUp(parsed.data);
  if (!result.ok) return { error: result.message };
  (await cookies()).set(ONBOARDING_COOKIE, result.data.draftId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/comecar",
    maxAge: 60 * 60 * 24,
  });
  revalidatePath("/comecar");
  return null;
}

export async function saveCompanyAction(input: CompanyStepInput): Promise<ActionResult> {
  const id = await currentId();
  if (!id) return expired;
  const parsed = companyStepSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await saveCompany(id, parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return null;
}

export async function startQrAction(): Promise<{ error: string } | { session: QrSession }> {
  const id = await currentId();
  if (!id) return expired;
  const result = await startQrSession(id);
  return result.ok ? { session: result.data } : { error: result.message };
}

export async function checkQrAction(
  sessionId: string,
): Promise<{ error: string } | { session: QrSession }> {
  const id = await currentId();
  if (!id) return expired;
  const result = await getQrSession(id, z.string().min(1).max(100).parse(sessionId));
  return result.ok ? { session: result.data } : { error: result.message };
}

export async function connectOfficialApiAction(
  input: OfficialApiInput,
): Promise<{ error: string } | { phone: string }> {
  const id = await currentId();
  if (!id) return expired;
  const parsed = officialApiSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await connectOfficialApi(id, parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return { phone: result.data.phone };
}

export async function skipWhatsappAction(): Promise<ActionResult> {
  const id = await currentId();
  if (!id) return expired;
  const result = await skipWhatsapp(id);
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return null;
}

export async function previewReplyAction(
  agent: AgentDraft,
  history: PreviewMessage[],
  message: string,
): Promise<{ error: string } | { reply: string }> {
  const draft = await getCurrentDraft();
  if (!draft) return expired;
  const parsedAgent = agentDraftSchema.safeParse(agent);
  if (!parsedAgent.success) return { error: firstIssue(parsedAgent.error) };
  const parsedHistory = z.array(previewMessageSchema).max(40).safeParse(history);
  const parsedMessage = z.string().trim().min(1).max(500).safeParse(message);
  if (!parsedHistory.success || !parsedMessage.success)
    return { error: "Escreva uma mensagem curta para testar." };
  const reply = await simulateAgentReply({
    agent: parsedAgent.data,
    company: draft.company,
    history: parsedHistory.data,
    message: parsedMessage.data,
  });
  return { reply };
}

export async function completeOnboardingAction(agent: AgentDraft | null): Promise<ActionResult> {
  const id = await currentId();
  if (!id) return expired;
  let value: AgentDraft | null = null;
  if (agent) {
    const parsed = agentDraftSchema.safeParse(agent);
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    value = parsed.data;
  }
  const result = await completeOnboarding(id, value);
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return null;
}

/** "Criar outra conta": descarta o cadastro em andamento. */
export async function resetOnboardingAction() {
  (await cookies()).delete({ name: ONBOARDING_COOKIE, path: "/comecar" });
  revalidatePath("/comecar");
}
