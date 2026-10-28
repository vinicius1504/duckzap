import type { OnboardingStep } from "@duckzap/contracts/onboarding";
import { Steps } from "@duckzap/ui/components/layout";
import { Logo } from "@duckzap/ui/components/logo";
import type { ReactNode } from "react";
import { FinishLaterButton } from "./finish-later-button";

export const wizardSteps = ["Empresa", "WhatsApp", "Primeiro agente"] as const;
export const stepOrder: readonly OnboardingStep[] = ["empresa", "whatsapp", "agente", "pronto"];

/** Cabeçalho com os passos + barra de progresso, como no design. */
export function OnboardingFrame({ step, children }: { step: OnboardingStep; children: ReactNode }) {
  const index = stepOrder.indexOf(step);
  const done = step === "pronto";
  const progress = done ? 100 : ((index + 1) / wizardSteps.length) * 100;

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-10 py-5 max-md:px-4 max-md:py-4">
        <Logo />
        <Steps
          steps={wizardSteps}
          current={done ? wizardSteps.length : index}
          label="Etapas da configuração"
        />
        {done ? <span className="max-sm:hidden" /> : <FinishLaterButton />}
      </header>
      <div className="h-1 bg-surface-2" aria-hidden="true">
        <div className="h-1 bg-duck transition-[width]" style={{ width: `${progress}%` }} />
      </div>
      <main className="flex flex-1 justify-center px-6 py-10 max-sm:px-4 max-sm:py-6">
        <div className="flex w-[min(960px,100%)] flex-col gap-6">{children}</div>
      </main>
    </div>
  );
}
