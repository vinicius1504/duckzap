import { pageTitleClass } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSampleConversation, getStepDefaults } from "@/features/onboarding/api";
import { AgentStep } from "@/features/onboarding/components/agent-step";
import { AuthSplit } from "@/features/onboarding/components/auth-split";
import { BeforeYouStart } from "@/features/onboarding/components/before-you-start";
import { CompanyStep } from "@/features/onboarding/components/company-step";
import { DoneStep } from "@/features/onboarding/components/done-step";
import { OnboardingFrame } from "@/features/onboarding/components/onboarding-frame";
import { SecurityStep } from "@/features/onboarding/components/security-step";
import { SignUpForm } from "@/features/onboarding/components/sign-up-form";
import { WhatsappStep } from "@/features/onboarding/components/whatsapp-step";
import { getCurrentDraft } from "@/features/onboarding/draft";
import { resolveOnboardingRoute } from "@/features/onboarding/steps";

export const metadata: Metadata = { title: "Criar conta" };

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ passo?: string }>;
}) {
  const draft = await getCurrentDraft();

  if (!draft) {
    return (
      <AuthSplit>
        <h1 className={pageTitleClass}>Crie sua conta grátis</h1>
        <p className="mb-5 mt-1.5 text-ink-2">
          Em poucos minutos seu WhatsApp já responde com um agente de IA.
        </p>
        <BeforeYouStart />
        <SignUpForm />
        <p className="mt-6 text-center text-ink-2">
          Já tem conta?{" "}
          <Link href="/entrar" className="font-bold text-ink underline">
            Entrar
          </Link>
        </p>
      </AuthSplit>
    );
  }

  // logado: o passo vem do banco pela sessão (sem depender do cookie legado). Passo da URL (?passo=whatsapp) limitado ao
  // mais adiantado já liberado; concluído (fora a tela "pronto") ou convidado (não é o dono) vão para o app.
  const route = resolveOnboardingRoute(draft, (await searchParams).passo);
  if (route.kind === "redirect") redirect(route.to);
  const safeStep = route.step;

  const defaults = await getStepDefaults(draft);

  return (
    <OnboardingFrame step={safeStep} canFinishLater={draft.company !== null}>
      {safeStep === "seguranca" ? <SecurityStep security={draft.security} /> : null}
      {safeStep === "empresa" ? <CompanyStep defaults={defaults.company} /> : null}
      {safeStep === "whatsapp" ? <WhatsappStep whatsapp={draft.whatsapp} /> : null}
      {safeStep === "agente" ? (
        <AgentStep
          defaults={defaults.agent}
          sample={await getSampleConversation(defaults.agent, draft.company)}
        />
      ) : null}
      {safeStep === "pronto" ? <DoneStep draft={draft} /> : null}
    </OnboardingFrame>
  );
}
