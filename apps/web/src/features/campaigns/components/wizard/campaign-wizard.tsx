"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Steps } from "@duckzap/ui/components/layout";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { launchCampaignAction, saveCampaignDraftAction } from "../../actions";
import { StepAudience } from "./step-audience";
import { StepMessage } from "./step-message";
import { StepReview } from "./step-review";
import { StepSending } from "./step-sending";
import { TermsDialog } from "./terms-dialog";
import type { Draft, WizardContext } from "./types";
import { validateStep } from "./validate";

const STEPS = ["Público", "Mensagem", "Envio", "Revisão"] as const;

export function CampaignWizard({ initialId, initialDraft, ctx }: { initialId: string | null; initialDraft: Draft; ctx: WizardContext }) {
  const router = useRouter();
  const [params, setParams] = useQueryStates({ rascunho: parseAsString, passo: parseAsInteger.withDefault(1) });
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [id, setId] = useState<string | null>(initialId);
  const [errors, setErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(ctx.terms.accepted);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // sem rascunho salvo não há como estar além do passo 1 (ex.: link copiado no meio)
  const step = id ? Math.min(Math.max(params.passo, 1), STEPS.length) - 1 : 0;

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setSavedAt(null);
  }

  async function save(): Promise<string | null> {
    // botões e opções vazios não vão para o servidor
    const payload: Draft = {
      ...draft,
      message: {
        ...draft.message,
        buttons: draft.message.buttons.map((b) => b.trim()).filter(Boolean),
        listItems: draft.message.listItems.filter((i) => i.title.trim()),
      },
    };
    const result = await saveCampaignDraftAction(id, payload);
    if (result.error !== undefined) {
      setServerError(result.error);
      return null;
    }
    setServerError(null);
    setId(result.data.id);
    setSavedAt(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone }));
    return result.data.id;
  }

  function goTo(next: number) {
    if (next > step) {
      for (let s = step; s < next; s++) {
        const found = validateStep(s, draft, ctx);
        if (found.length) {
          setErrors(found);
          return;
        }
      }
    }
    setErrors([]);
    startTransition(async () => {
      const savedId = await save();
      if (!savedId) return;
      await setParams({ rascunho: savedId, passo: next + 1 });
      headingRef.current?.focus();
    });
  }

  function saveOnly() {
    startTransition(async () => {
      const savedId = await save();
      if (savedId && !params.rascunho) await setParams({ rascunho: savedId });
    });
  }

  function launch() {
    for (let s = 0; s < 3; s++) {
      const found = validateStep(s, draft, ctx);
      if (found.length) {
        setErrors([`Passo ${s + 1} (${STEPS[s]}): ${found[0]}`]);
        return;
      }
    }
    if (!termsAccepted) {
      setTermsOpen(true);
      return;
    }
    launchAfterTerms();
  }

  const stepProps = { draft, update, ctx, errors };

  return (
    <Card className="flex flex-col gap-6 p-6 max-sm:p-4">
      <Steps steps={STEPS} current={step} label="Passos da campanha" />
      <h2 ref={headingRef} tabIndex={-1} className="sr-only">
        Passo {step + 1} de {STEPS.length}: {STEPS[step]}
      </h2>

      {errors.length ? (
        <Alert tone="err" live title="Falta pouco:">
          <ul className="list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {serverError ? (
        <Alert tone="err" live>
          {serverError}
        </Alert>
      ) : null}

      {step === 0 ? <StepAudience {...stepProps} /> : null}
      {step === 1 ? <StepMessage {...stepProps} /> : null}
      {step === 2 ? <StepSending {...stepProps} /> : null}
      {step === 3 ? (
        <StepReview {...stepProps} termsAccepted={termsAccepted} onEdit={(s) => goTo(s)} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-[13px] text-ink-2" aria-live="polite">
          {pending ? "Salvando…" : savedAt ? `Rascunho salvo às ${savedAt}` : id ? "Rascunho salvo" : "Ainda não salvo"}
        </p>
        <div className="flex flex-wrap gap-2">
          {step > 0 ? (
            <Button disabled={pending} onClick={() => goTo(step - 1)}>
              <Icon name="arrowLeft" size={16} /> Voltar
            </Button>
          ) : null}
          <Button variant="ghost" disabled={pending} onClick={saveOnly}>
            Salvar rascunho
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={pending} onClick={() => goTo(step + 1)}>
              {pending ? <Spinner size={16} /> : null}
              Continuar para {STEPS[step + 1]?.toLowerCase()}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              disabled={pending || ctx.sendBlockedReason !== null}
              title={ctx.sendBlockedReason ?? undefined}
              onClick={launch}
            >
              {pending ? <Spinner size={16} /> : <Icon name="send" size={16} />}
              {draft.sending.scheduleMode === "scheduled" ? "Agendar envio" : "Disparar agora"}
            </Button>
          )}
        </div>
      </div>
      {step === STEPS.length - 1 && ctx.sendBlockedReason ? (
        <p className="text-right text-[13px] font-semibold text-err">{ctx.sendBlockedReason}</p>
      ) : null}
      {!termsAccepted ? (
        <p className="text-[13px] text-ink-2">Antes do primeiro disparo você precisará aceitar os termos de uso de campanhas.</p>
      ) : null}

      <TermsDialog
        open={termsOpen}
        onOpenChange={setTermsOpen}
        version={ctx.terms.version}
        onAccepted={() => {
          setTermsAccepted(true);
          setTermsOpen(false);
          launchAfterTerms();
        }}
      />
    </Card>
  );

  function launchAfterTerms() {
    startTransition(async () => {
      const savedId = await save();
      if (!savedId) return;
      const result = await launchCampaignAction(savedId);
      if (result.error !== undefined) setServerError(result.error);
      else router.push(`/campanhas/${savedId}`);
    });
  }
}
