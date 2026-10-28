import { onboardingStepSchema, type OnboardingStep } from "@duckzap/contracts/onboarding";
import type { Metadata } from "next";
import Link from "next/link";
import { getSampleConversation, getStepDefaults } from "@/features/onboarding/api";
import { AgentStep } from "@/features/onboarding/components/agent-step";
import { AuthSplit } from "@/features/onboarding/components/auth-split";
import { CompanyStep } from "@/features/onboarding/components/company-step";
import { DoneStep } from "@/features/onboarding/components/done-step";
import { OnboardingFrame, stepOrder } from "@/features/onboarding/components/onboarding-frame";
import { SignUpForm } from "@/features/onboarding/components/sign-up-form";
import { WhatsappStep } from "@/features/onboarding/components/whatsapp-step";
import { furthestStep, getCurrentDraft } from "@/features/onboarding/draft";

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
        <h1 className="text-[28px] font-extrabold tracking-[-0.02em]">Crie sua conta grátis</h1>
        <p className="mb-7 mt-1.5 text-ink-2">
          Em poucos minutos seu WhatsApp já responde com um agente de IA.
        </p>
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

  // passo da URL (?passo=whatsapp), limitado ao mais adiantado que já pode ser aberto
  const furthest = furthestStep(draft);
  const requested = onboardingStepSchema.catch(furthest).parse((await searchParams).passo);
  const safeStep: OnboardingStep =
    furthest === "pronto"
      ? "pronto"
      : stepOrder.indexOf(requested) <= stepOrder.indexOf(furthest)
        ? requested
        : furthest;

  const defaults = await getStepDefaults(draft);

  return (
    <OnboardingFrame step={safeStep}>
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
