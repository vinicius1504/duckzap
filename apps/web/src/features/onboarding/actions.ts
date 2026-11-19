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
import { signOut } from "@/features/auth/api";
import { getCurrentDraft, LEGACY_ONBOARDING_COOKIE } from "./draft";

// Server Actions finas: validação → api.ts → revalidar. Quem é a pessoa vem da SESSÃO (o api.ts fala com a API com o
// cookie de sessão); a API recusa (401) quem não está logado e cada ação devolve "expirou".

type ActionResult = { error: string } | null;

const expired = { error: "Seu cadastro expirou. Recarregue a página para começar de novo." };

function firstIssue(error: { issues: { message: string }[] }) {
  return error.issues[0]?.message ?? "Confira os dados e tente de novo.";
}

export async function signUpAction(input: SignUpInput): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await createSignUp(parsed.data);
  if (!result.ok) return { error: result.message };
  // a conta já nasce logada (cookie de sessão repassado): o passo seguinte vem da sessão
  revalidatePath("/comecar");
  return null;
}

export async function saveCompanyAction(input: CompanyStepInput): Promise<ActionResult> {
  const parsed = companyStepSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await saveCompany(parsed.data);
  if (!result.ok && result.error === "not_found") return expired;
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return null;
}

export async function startQrAction(): Promise<{ error: string } | { session: QrSession }> {
  const result = await startQrSession();
  return result.ok ? { session: result.data } : { error: result.message };
}

export async function checkQrAction(
  sessionId: string,
): Promise<{ error: string } | { session: QrSession }> {
  const parsed = z.string().min(1).max(100).safeParse(sessionId);
  if (!parsed.success) return { error: "Código não encontrado. Gere um novo." };
  const result = await getQrSession(parsed.data);
  return result.ok ? { session: result.data } : { error: result.message };
}

export async function connectOfficialApiAction(
  input: OfficialApiInput,
): Promise<{ error: string } | { phone: string }> {
  const parsed = officialApiSchema.safeParse(input);
  if (!parsed.success) return { error: firstIssue(parsed.error) };
  const result = await connectOfficialApi(parsed.data);
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return { phone: result.data.phone };
}

export async function skipWhatsappAction(): Promise<ActionResult> {
  const result = await skipWhatsapp();
  if (!result.ok) return result.error === "not_found" ? expired : { error: result.message };
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
  let value: AgentDraft | null = null;
  if (agent) {
    const parsed = agentDraftSchema.safeParse(agent);
    if (!parsed.success) return { error: firstIssue(parsed.error) };
    value = parsed.data;
  }
  const result = await completeOnboarding(value);
  if (!result.ok) return { error: result.message };
  revalidatePath("/comecar");
  return null;
}

/**
 * "Criar outra conta" (tela "pronto"): o cadastro vem da sessão, então trocar de conta é SAIR. A conta e a empresa
 * criadas continuam salvas (entrar de novo leva ao app). Apaga também o cookie legado do cadastro.
 */
export async function resetOnboardingAction() {
  await signOut();
  (await cookies()).delete({ name: LEGACY_ONBOARDING_COOKIE, path: "/comecar" });
  revalidatePath("/comecar");
}
