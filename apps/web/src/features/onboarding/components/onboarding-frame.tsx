import type { OnboardingStep } from "@duckzap/contracts/onboarding";
import { Steps } from "@duckzap/ui/components/layout";
import { Logo } from "@duckzap/ui/components/logo";
import type { ReactNode } from "react";
import { stepOrder, wizardSteps } from "../steps";
import { FinishLaterButton } from "./finish-later-button";

/**
 * Cabeçalho com os passos + barra de progresso, como no design. `canFinishLater`: a empresa já existe, então dá para
 * concluir agora e deixar WhatsApp/agente para depois; antes disso o botão só sai (o progresso fica salvo).
 */
export function OnboardingFrame({
  step,
  canFinishLater,
  children,
}: {
  step: OnboardingStep;
  canFinishLater: boolean;
  children: ReactNode;
}) {
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
        {done ? <span className="max-sm:hidden" /> : <FinishLaterButton canFinish={canFinishLater} />}
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
