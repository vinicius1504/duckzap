"use client";

import type { AgentConfig } from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { Radio } from "@duckzap/ui/components/form-controls";
import {
  GENERATOR_SECTIONS,
  SECTION_LABELS,
  describeCurrentSection,
  type GeneratorSection,
  type SectionChoice,
  type SectionChoices,
} from "@/lib/agent-generator-apply";
import { GEN_IDS } from "../use-generation";

/**
 * Antes de sobrescrever: lista as partes do agente que já têm conteúdo e deixa escolher, uma a uma, entre substituir e
 * manter. O foco vem para cá quando o painel aparece. Nada é salvo: o resultado entra no editor como alteração não salva.
 */
export function ApplyConfirmPanel({
  config,
  sections,
  choices,
  onChoice,
  onConfirm,
  onDiscard,
}: {
  config: AgentConfig;
  sections: GeneratorSection[];
  choices: SectionChoices;
  onChoice: (section: GeneratorSection, choice: SectionChoice) => void;
  onConfirm: () => void;
  onDiscard: () => void;
}) {
  const untouched = GENERATOR_SECTIONS.filter((section) => !sections.includes(section));
  const allKept = sections.every((section) => choices[section] === "keep") && untouched.length === 0;
  return (
    <div
      id={GEN_IDS.confirm}
      tabIndex={-1}
      role="group"
      aria-labelledby="gen-confirm-title"
      className="flex flex-col gap-3 rounded-control border border-warn bg-warn-bg p-4 text-ink outline-none"
    >
      <div>
        <h3 id="gen-confirm-title" className="text-[15px] font-bold text-warn">
          Estas partes do agente já têm conteúdo
        </h3>
        <p className="mt-0.5 text-[13px]">Escolha o que substituir pelo texto gerado. Nada é salvo: o resultado entra no editor como alteração não salva e “Descartar” desfaz.</p>
      </div>
      {sections.map((section) => (
        <fieldset key={section} className="rounded-control bg-surface p-3">
          <legend className="px-1 text-[13px] font-bold">
            {SECTION_LABELS[section].title} <span className="font-normal text-ink-2">({SECTION_LABELS[section].detail})</span>
          </legend>
          <p className="mb-1 text-xs text-ink-2">Hoje no agente: {describeCurrentSection(config, section)}.</p>
          {(["replace", "keep"] as const).map((choice) => (
            <label key={choice} className="flex min-h-11 items-center gap-2.5">
              <Radio name={`gen-choice-${section}`} checked={choices[section] === choice} onChange={() => onChoice(section, choice)} />
              {choice === "replace" ? "Substituir pelo texto gerado" : "Manter o que já está no agente"}
            </label>
          ))}
        </fieldset>
      ))}
      {untouched.length ? <p className="text-[13px]">Sem conteúdo hoje, entram direto: {untouched.map((section) => SECTION_LABELS[section].title).join(", ")}.</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button className="max-md:h-11" onClick={onDiscard}>
          Descartar o resultado
        </Button>
        <Button variant="primary" className="max-md:h-11" onClick={onConfirm} disabled={allKept}>
          Aplicar escolhas
        </Button>
      </div>
      {allKept ? <p className="text-right text-xs text-ink-2">Tudo em “manter”: não há nada para aplicar. Descarte o resultado ou troque alguma escolha.</p> : null}
    </div>
  );
}
