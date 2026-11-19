import type { OnboardingDraft, OnboardingStep } from "@duckzap/contracts/onboarding";
import type { Session } from "@duckzap/contracts/session";

// Regras PURAS do cadastro (/comecar), sem servidor: que passo abrir, quando mandar para o app e quem precisa voltar.
// O estado vem do banco (GET /v1/onboarding), então recarregar, reiniciar o servidor ou perder o cookie não muda o passo.
//
// Para acrescentar um passo:
//   1. o id em `onboardingStepSchema` (packages/contracts/src/onboarding.ts), ANTES de "pronto";
//   2. uma entrada em `wizard` abaixo, na posição certa, com `done` lendo o rascunho (se o passo tiver estado,
//      ele precisa vir DURÁVEL do back: um campo em `onboardingStateSchema`/`OnboardingDraft` derivado do banco);
//   3. o ramo que desenha o passo em app/(auth)/comecar/page.tsx e o botão "Continuar" do passo anterior apontando para ele.
// `stepOrder`, o cabeçalho com as etapas e `furthestStep` se ajustam sozinhos.

type DraftProgress = Pick<OnboardingDraft, "security" | "company" | "whatsapp" | "completedAt">;

type WizardStep = {
  id: Exclude<OnboardingStep, "pronto">;
  /** Nome no cabeçalho de etapas. */
  label: string;
  /** O passo já foi resolvido (a pessoa pode seguir adiante). */
  done: (draft: DraftProgress) => boolean;
};

const wizard: readonly WizardStep[] = [
  // opcional: feito com o 2FA ativo (app ou e-mail, inclusive ativado depois em Ajustes) ou com "Pular por enquanto"
  { id: "seguranca", label: "Segurança", done: (d) => d.security.twoFactorEnabled || d.security.skippedAt !== null },
  { id: "empresa", label: "Empresa", done: (d) => d.company !== null },
  { id: "whatsapp", label: "WhatsApp", done: (d) => d.whatsapp !== null },
  // o último passo só termina ao concluir (POST /v1/onboarding/complete), que leva a "pronto"
  { id: "agente", label: "Primeiro agente", done: () => false },
];

export const wizardSteps: readonly string[] = wizard.map((s) => s.label);
export const stepOrder: readonly OnboardingStep[] = [...wizard.map((s) => s.id), "pronto"];

/** Passo mais adiantado que a pessoa pode abrir (não deixa pular etapas pela URL). */
export function furthestStep(draft: DraftProgress): OnboardingStep {
  if (draft.completedAt) return "pronto";
  return wizard.find((s) => !s.done(draft))?.id ?? wizard[wizard.length - 1]!.id;
}

export type OnboardingRoute = { kind: "step"; step: OnboardingStep } | { kind: "redirect"; to: "/inicio" };

/**
 * O que /comecar mostra para quem já tem conta (sessão):
 *  - cadastro concluído: só a tela "pronto" (logo depois de concluir, `?passo=pronto`); qualquer outro passo vai para o app;
 *  - quem não é o dono (entrou por convite numa empresa existente) nunca faz o cadastro: vai para o app;
 *  - senão, o passo pedido na URL, limitado ao mais adiantado já liberado.
 */
export function resolveOnboardingRoute(
  draft: DraftProgress & Pick<OnboardingDraft, "role">,
  requested: string | undefined,
): OnboardingRoute {
  if (draft.completedAt) return requested === "pronto" ? { kind: "step", step: "pronto" } : { kind: "redirect", to: "/inicio" };
  if (draft.role !== null && draft.role !== "owner") return { kind: "redirect", to: "/inicio" };
  const furthest = furthestStep(draft);
  const asked = stepOrder.find((s) => s === requested) ?? furthest;
  return { kind: "step", step: stepOrder.indexOf(asked) <= stepOrder.indexOf(furthest) ? asked : furthest };
}

/** O layout do app manda de volta a /comecar só o DONO de empresa com cadastro em aberto (convidados nunca). */
export function needsOnboarding(session: Session): boolean {
  return session.user.role === "owner" && !session.organization.onboardingCompleted;
}
