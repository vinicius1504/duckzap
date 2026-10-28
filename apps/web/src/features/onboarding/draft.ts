import "server-only";
import type { OnboardingDraft, OnboardingStep } from "@duckzap/contracts/onboarding";
import { cookies } from "next/headers";
import { getDraft } from "./api";

/**
 * Cadastro em andamento (antes de existir sessão). Cookie próprio do onboarding, não é o de auth:
 * no back, o sign-up já devolve a sessão e este cookie some.
 */
export const ONBOARDING_COOKIE = "dz_onboarding";

export async function getCurrentDraft(): Promise<OnboardingDraft | null> {
  const id = (await cookies()).get(ONBOARDING_COOKIE)?.value;
  return id ? getDraft(id) : null;
}

/** Passo mais adiantado que a pessoa pode abrir (não deixa pular etapas pela URL). */
export function furthestStep(draft: OnboardingDraft): OnboardingStep {
  if (draft.completedAt) return "pronto";
  if (!draft.company) return "empresa";
  if (!draft.whatsapp) return "whatsapp";
  return "agente";
}
