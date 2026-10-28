"use client";

import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import { Switch } from "@duckzap/ui/components/switch";
import { useState } from "react";
import {
  FOLLOW_UP_EXAMPLES,
  FOLLOW_UP_EXTRA_MAX,
  MAX_FOLLOW_UP_STEPS,
  WAIT_LIMITS,
  WAIT_UNITS,
  addStep,
  canAddStep,
  defaultFollowUpLayout,
  followUpLayoutSummary,
  isAscending,
  moveStep,
  removeStep,
  setStepAmount,
  setStepUnit,
  stepLabel,
  type FollowUpLayoutState,
  type WaitUnit,
} from "@/lib/follow-up-layout";
import { CharCounter } from "./char-counter";

function unitOf(value: string): WaitUnit {
  return WAIT_UNITS.find((unit) => unit.value === value)?.value ?? "hours";
}

/**
 * PRÉVIA DE LAYOUT do "Follow-up automático" (topo da página Agentes). Ainda não envia mensagens e não grava nada: o estado é
 * só local (`useState`), sem actions e sem chamada à API. O follow-up é um agente fixo do sistema — ele lê a conversa e
 * escreve cada mensagem —, então a empresa só define QUANDO (as etapas são só tempo de espera) e algumas regras.
 */
export function FollowUpPreviewCard() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FollowUpLayoutState>(defaultFollowUpLayout);
  const [announcement, setAnnouncement] = useState("");
  const patch = (change: Partial<FollowUpLayoutState>) => setState((current) => ({ ...current, ...change }));
  const extraLength = state.extraInstructions.length;

  return (
    <Card className="flex flex-col">
      <h2 className="p-3.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="fu-preview-body"
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full items-center gap-3 rounded-control text-left hover:bg-surface-hover"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-2">
            <Icon name="clock" size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 font-bold">
              Follow-up automático <Chip tone="warn">Prévia do layout</Chip>
            </span>
            <span className="block text-[13px] font-normal text-ink-2">{followUpLayoutSummary(state)}</span>
          </span>
          <Icon name="chevronDown" size={18} className={open ? "shrink-0 rotate-180" : "shrink-0"} />
        </button>
      </h2>

      {open ? (
        <div id="fu-preview-body" className="flex flex-col gap-5 border-t border-line p-4 max-sm:p-3.5">
          <Alert tone="warn" title="Prévia do layout — ainda não envia mensagens.">
            O envio automático será ligado em breve. Nada do que você mexer aqui é salvo.
          </Alert>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <label htmlFor="fu-enabled" className="block cursor-pointer font-semibold">
                Retomar conversas quando o cliente parar de responder
              </label>
              <p id="fu-enabled-help" className="mt-0.5 text-[13px] text-ink-2">
                Vale para as conversas de todos os seus agentes.
              </p>
            </div>
            <Switch id="fu-enabled" checked={state.enabled} aria-describedby="fu-enabled-help" onCheckedChange={(enabled) => patch({ enabled })} className="mt-0.5 max-md:my-2" />
          </div>

          <section aria-labelledby="fu-steps-title" className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="fu-steps-title" className="font-bold">
                Quando retomar
              </h3>
              <span className="text-xs text-ink-2">
                {state.steps.length} de {MAX_FOLLOW_UP_STEPS} etapas
              </span>
            </div>

            {state.steps.length === 0 ? (
              <p className="rounded-control bg-surface-2 p-3 text-[13px] text-ink-2">Nenhuma etapa. Adicione a primeira, por exemplo 2 h depois da última mensagem do cliente.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {state.steps.map((step, index) => {
                  const limits = WAIT_LIMITS[step.unit];
                  return (
                    <li key={step.id} className="flex flex-wrap items-end gap-2 rounded-control border border-line p-3">
                      <span className="w-full text-[13px] font-semibold sm:w-auto sm:min-w-24 sm:pb-2.5">
                        Etapa {index + 1}: {stepLabel(step)}
                      </span>
                      <div className="w-24">
                        <Label htmlFor={`fu-amount-${step.id}`}>Tempo de espera da etapa {index + 1}</Label>
                        <Input
                          id={`fu-amount-${step.id}`}
                          type="number"
                          inputMode="numeric"
                          min={limits.min}
                          max={limits.max}
                          value={step.amount}
                          onChange={(e) => setState((current) => ({ ...current, steps: setStepAmount(current.steps, step.id, Number(e.target.value)) }))}
                        />
                      </div>
                      <div className="w-32">
                        <Label htmlFor={`fu-unit-${step.id}`}>Unidade da etapa {index + 1}</Label>
                        <Select
                          id={`fu-unit-${step.id}`}
                          className="h-11"
                          value={step.unit}
                          onChange={(e) => setState((current) => ({ ...current, steps: setStepUnit(current.steps, step.id, unitOf(e.target.value)) }))}
                        >
                          {WAIT_UNITS.map((unit) => (
                            <option key={unit.value} value={unit.value}>
                              {unit.labelPlural}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="ml-auto flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="max-md:size-11"
                          aria-label={`Subir a etapa ${index + 1}`}
                          disabled={index === 0}
                          onClick={() => {
                            setState((current) => ({ ...current, steps: moveStep(current.steps, step.id, -1) }));
                            setAnnouncement(`Etapa ${index + 1} movida para a posição ${index}.`);
                          }}
                        >
                          <Icon name="chevronDown" size={16} className="rotate-180" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="max-md:size-11"
                          aria-label={`Descer a etapa ${index + 1}`}
                          disabled={index === state.steps.length - 1}
                          onClick={() => {
                            setState((current) => ({ ...current, steps: moveStep(current.steps, step.id, 1) }));
                            setAnnouncement(`Etapa ${index + 1} movida para a posição ${index + 2}.`);
                          }}
                        >
                          <Icon name="chevronDown" size={16} />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-err max-md:size-11"
                          aria-label={`Remover a etapa ${index + 1}`}
                          onClick={() => {
                            setState((current) => ({ ...current, steps: removeStep(current.steps, step.id) }));
                            setAnnouncement(`Etapa ${index + 1} removida.`);
                          }}
                        >
                          <Icon name="trash" size={16} />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="max-md:h-11"
                disabled={!canAddStep(state.steps)}
                onClick={() => {
                  setState((current) => ({ ...current, steps: addStep(current.steps) }));
                  setAnnouncement("Etapa adicionada.");
                }}
              >
                <Icon name="plus" size={16} /> Adicionar etapa
              </Button>
              {!canAddStep(state.steps) ? <span className="text-xs text-ink-2">Máximo de {MAX_FOLLOW_UP_STEPS} etapas.</span> : null}
            </div>
            <p className="text-[13px] text-ink-2">O agente de follow-up lê a conversa e escreve cada mensagem; você só define quando.</p>
            {!isAscending(state.steps) ? <p className="text-xs text-ink-2">Dica: as esperas costumam ficar em ordem crescente (por exemplo 2 h, depois 24 h, depois 3 dias).</p> : null}
          </section>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-bold">Regras</legend>
            <label className="flex min-h-11 items-center gap-2.5">
              <Checkbox checked={state.respectBusinessHours} onChange={(e) => patch({ respectBusinessHours: e.target.checked })} />
              Respeitar o horário comercial
            </label>
            <label className="flex min-h-11 items-center gap-2.5">
              <Checkbox checked={state.stopOnReply} onChange={(e) => patch({ stopOnReply: e.target.checked })} />
              Parar quando o cliente responder
            </label>
          </fieldset>

          <div>
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
              <Label htmlFor="fu-extra" className="mb-0">
                Instruções extras para o follow-up (opcional)
              </Label>
              <CharCounter id="fu-extra-count" length={extraLength} max={FOLLOW_UP_EXTRA_MAX} />
            </div>
            <Textarea
              id="fu-extra"
              rows={3}
              value={state.extraInstructions}
              aria-describedby="fu-extra-count"
              placeholder="Ex.: se o cliente pediu orçamento, ofereça uma ligação."
              onChange={(e) => patch({ extraInstructions: e.target.value })}
            />
          </div>

          <section aria-labelledby="fu-example-title" className="flex flex-col gap-2 rounded-control bg-surface-2 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="fu-example-title" className="font-bold">
                Exemplo do que o agente escreveria
              </h3>
              <Chip>Ilustração</Chip>
            </div>
            <ul className="flex flex-col gap-2">
              {FOLLOW_UP_EXAMPLES.map((text) => (
                <li key={text} className="max-w-[90%] self-start rounded-xl rounded-tl-sm bg-surface px-3 py-2 text-[13px]">
                  {text}
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink-2">Mensagens fictícias, só para mostrar o tom. Cada mensagem real é escrita a partir da conversa com o cliente.</p>
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" className="max-md:h-11" disabled aria-describedby="fu-save-help">
              Salvar
            </Button>
            <p id="fu-save-help" className="min-w-0 flex-[1_1_220px] text-[13px] text-ink-2">
              Disponível quando o envio automático for ligado.
            </p>
          </div>

          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>
      ) : null}
    </Card>
  );
}
