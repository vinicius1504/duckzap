"use client";

import {
  AGENT_GENERATOR_PURPOSE_LABELS,
  AGENT_OBJECTIVE_SUGGESTIONS,
  AGENT_RESTRICTION_SUGGESTIONS,
  agentToneSchema,
  type AgentConfig,
  type AgentGeneratorPurpose,
} from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { chipVariants } from "@duckzap/ui/components/chip";
import { Spinner } from "@duckzap/ui/components/feedback";
import { Select } from "@duckzap/ui/components/form-controls";
import { Icon, type IconName } from "@duckzap/ui/components/icon";
import { Label } from "@duckzap/ui/components/input";
import { Tabs, TabsContent } from "@duckzap/ui/components/tabs";
import { cn } from "@duckzap/ui/cn";
import { useEffect, useState } from "react";
import {
  COMPANY_TEXT_MIN,
  GENERATOR_FIELD_LABELS,
  GENERATOR_LIMITS,
  PURPOSE_HELP,
  SELECTABLE_PURPOSES,
  SIMPLE_SECTIONS,
  TONE_HELP,
  addLine,
  blockerSentence,
  displayPurpose,
  essentialIssues,
  formFromConfig,
  generationBlockers,
  hasLine,
  setFormField,
  simpleSectionNeedsAttention,
  storedExtraLabels,
  toggleLine,
  type EssentialField,
  type GeneratorField,
  type SimpleSectionId,
} from "@/lib/agent-generator";
import { toneLabel } from "../labels";
import { GEN_IDS, type GenerationApi } from "../use-generation";
import { CountedField } from "./field";
import { useCooldownLeft } from "./generation-status";
import { SegmentedTabsList, SegmentedTabsTrigger } from "./segmented-tabs";

const COMPANY_PLACEHOLDER =
  "Ex.: Minha empresa é do ramo de alimentação natural… Cole aqui o texto do seu site, do Instagram, serviços, produtos, preços, horários, perguntas que os clientes fazem…";

const PURPOSE_ICONS: Record<AgentGeneratorPurpose, IconName> = {
  reception: "users",
  sales: "chart",
  support: "help",
  scheduling: "calendar",
};

/** Chips de sugestão: clicar marca (acrescenta a linha), clicar de novo desmarca. Cabe no limite do campo ou fica desabilitado. */
function SuggestionChips({
  label,
  suggestions,
  value,
  max,
  onChange,
}: {
  label: string;
  suggestions: readonly string[];
  value: string;
  max: number;
  onChange: (next: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {suggestions.map((line) => {
        const used = hasLine(value, line);
        const fits = used || addLine(value, line, max) !== null;
        return (
          <button
            key={line}
            type="button"
            aria-pressed={used}
            disabled={!fits}
            title={!fits ? "Não cabe: o campo chegou ao limite de caracteres." : undefined}
            onClick={() => {
              const next = toggleLine(value, line, max);
              if (next !== null) onChange(next);
            }}
            className={cn(
              chipVariants({ tone: "neutral" }),
              "h-auto min-h-8 cursor-pointer items-center gap-1.5 whitespace-normal border border-line py-1 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11",
              used && "border-ink bg-ink text-bg hover:bg-ink",
            )}
          >
            <Icon name={used ? "check" : "plus"} size={14} strokeWidth={2.2} />
            {line}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Seção "Configuração simples" (modelo MillionZap): finalidade em botões grandes, nome e modo de interação lado a lado, um
 * texto por sub-aba (informações da empresa, objetivos, restrições) e o botão que gera o prompt. Só o nome e as informações
 * da empresa são obrigatórios. Tudo mora em `config` (nome, modo e `config.generator`): não há estado de formulário aqui.
 */
export function SimpleConfigTab({
  config,
  setConfig,
  fallbackPurpose,
  generation,
}: {
  config: AgentConfig;
  setConfig: (next: AgentConfig) => void;
  fallbackPurpose: AgentGeneratorPurpose;
  generation: GenerationApi;
}) {
  const form = formFromConfig(config, fallbackPurpose);
  // agente antigo com "Agendamento": mostra Recepção sem mexer no valor guardado (só muda se a pessoa escolher outra)
  const shownPurpose = displayPurpose(form.purpose);
  const { generating, fieldErrors } = generation;
  const cooldownLeft = useCooldownLeft(generation.cooldown);
  const [subTab, setSubTab] = useState<SimpleSectionId>("company");
  const [touched, setTouched] = useState<ReadonlySet<EssentialField>>(new Set());

  // erro (do servidor ou da validação) num texto de outra sub-aba: abre a sub-aba dele
  const errorSection = SIMPLE_SECTIONS.find((section) => fieldErrors[section.field] !== undefined)?.id;
  useEffect(() => {
    if (errorSection) setSubTab(errorSection);
  }, [errorSection, fieldErrors]);

  const set = (field: GeneratorField, value: string) => {
    setConfig(setFormField(config, fallbackPurpose, field, value));
    if (fieldErrors[field]) generation.clearFieldError(field);
  };
  const touch = (field: EssentialField) => setTouched((current) => new Set(current).add(field));
  const issues = essentialIssues(form);
  /** Erro do campo obrigatório: o do servidor/geração ou, depois que a pessoa saiu do campo, o que falta. */
  const essentialError = (field: EssentialField) => fieldErrors[field] ?? (touched.has(field) ? issues[field] : undefined);

  const blockers = generationBlockers(form);
  const blocked = blockers.length > 0;
  const sentence = blockerSentence(blockers);
  const again = generation.hasGenerated || (Boolean(config.generator) && config.advanced.prompt.trim().length > 0);
  const extraLabels = storedExtraLabels(config.generator);

  return (
    <div className="flex flex-col gap-6">
      <fieldset disabled={generating} className="flex min-w-0 flex-col gap-6 border-0 p-0">
        <legend className="sr-only">Dados para gerar o prompt do agente</legend>

        <div>
          <p className="mb-1.5 text-[13px] font-semibold" id="gen-purpose-label">
            Finalidade do agente <span className="text-err">*</span>
          </p>
          <div role="radiogroup" aria-labelledby="gen-purpose-label" className="grid grid-cols-3 gap-2">
            {SELECTABLE_PURPOSES.map((option) => (
              <label
                key={option}
                className={cn(
                  "flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-control border border-line bg-surface p-3 text-center font-semibold text-ink-2 hover:bg-surface-hover has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink",
                  shownPurpose === option && "border-ink bg-surface-2 text-ink ring-1 ring-ink",
                )}
              >
                <input
                  type="radio"
                  name="gen-purpose"
                  value={option}
                  checked={shownPurpose === option}
                  onChange={() => set("purpose", option)}
                  className="sr-only"
                />
                <Icon name={PURPOSE_ICONS[option]} size={22} />
                <span className="text-[13px] leading-tight">{AGENT_GENERATOR_PURPOSE_LABELS[option]}</span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-ink-2" aria-live="polite">
            {PURPOSE_HELP[shownPurpose]}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <CountedField
            id={GEN_IDS.field("agentName")}
            label={GENERATOR_FIELD_LABELS.agentName}
            value={form.agentName}
            onChange={(value) => set("agentName", value)}
            onBlur={() => touch("agentName")}
            max={GENERATOR_LIMITS.agentName}
            single
            placeholder="Ex.: Duda"
            help="É como o agente se apresenta ao cliente."
            error={essentialError("agentName")}
            required
            trimmedCount
          />
          <div>
            <Label htmlFor="gen-tone">Modo de interação</Label>
            <Select id="gen-tone" className="h-11" value={form.tone} aria-describedby="gen-tone-help" onChange={(e) => set("tone", e.target.value)}>
              {agentToneSchema.options.map((tone) => (
                <option key={tone} value={tone}>
                  {toneLabel[tone]}
                </option>
              ))}
            </Select>
            <p id="gen-tone-help" className="mt-1 text-xs text-ink-2" aria-live="polite">
              {TONE_HELP[form.tone]}
            </p>
          </div>
        </div>

        <Tabs value={subTab} onValueChange={(value) => setSubTab(SIMPLE_SECTIONS.find((section) => section.id === value)?.id ?? "company")}>
          <SegmentedTabsList aria-label="Textos do agente">
            {SIMPLE_SECTIONS.map((section) => {
              const attention = simpleSectionNeedsAttention(section.id, form, fieldErrors);
              return (
                <SegmentedTabsTrigger key={section.id} value={section.id} className="text-[13px]">
                  {section.label}
                  {section.required ? <span aria-hidden="true" className="ml-0.5 text-err">*</span> : null}
                  {attention ? (
                    <>
                      <span aria-hidden="true" className="ml-1.5 inline-block size-2 rounded-full bg-err align-middle" />
                      <span className="sr-only"> (precisa de atenção)</span>
                    </>
                  ) : null}
                </SegmentedTabsTrigger>
              );
            })}
          </SegmentedTabsList>

          <TabsContent value="company" className="pt-4">
            <CountedField
              id={GEN_IDS.field("companyText")}
              label="Informações da empresa (links e informações)"
              value={form.companyText}
              onChange={(value) => set("companyText", value)}
              onBlur={() => touch("companyText")}
              max={GENERATOR_LIMITS.companyText}
              rows={12}
              placeholder={COMPANY_PLACEHOLDER}
              help={`Cole o TEXTO do seu site, Instagram ou catálogo — links não são lidos automaticamente. Mínimo de ${COMPANY_TEXT_MIN} caracteres.`}
              error={essentialError("companyText")}
              required
              trimmedCount
            />
          </TabsContent>

          <TabsContent value="goals" className="flex flex-col gap-2 pt-4">
            <CountedField
              id={GEN_IDS.field("customInstructions")}
              label="Objetivos / instruções (opcional)"
              value={form.customInstructions}
              onChange={(value) => set("customInstructions", value)}
              max={GENERATOR_LIMITS.customInstructions}
              rows={8}
              placeholder="Ex.: Perguntar o nome do cliente no início. Sempre oferecer a avaliação gratuita."
              help="Uma instrução por linha. Clique numa sugestão para adicionar; clique de novo para tirar."
              error={fieldErrors.customInstructions}
              trimmedCount
            />
            <SuggestionChips
              label="Sugestões do que a IA deve fazer"
              suggestions={AGENT_OBJECTIVE_SUGGESTIONS}
              value={form.customInstructions}
              max={GENERATOR_LIMITS.customInstructions}
              onChange={(value) => set("customInstructions", value)}
            />
          </TabsContent>

          <TabsContent value="restrictions" className="flex flex-col gap-2 pt-4">
            <CountedField
              id={GEN_IDS.field("restrictions")}
              label="Restrições (o que a IA NÃO deve fazer, opcional)"
              value={form.restrictions}
              onChange={(value) => set("restrictions", value)}
              max={GENERATOR_LIMITS.restrictions}
              rows={8}
              placeholder="Ex.: Nunca prometer prazo de entrega. Não falar de concorrentes."
              help="Uma regra por linha. Clique numa sugestão para adicionar; clique de novo para tirar."
              error={fieldErrors.restrictions}
              trimmedCount
            />
            <SuggestionChips
              label="Sugestões do que a IA não deve fazer"
              suggestions={AGENT_RESTRICTION_SUGGESTIONS}
              value={form.restrictions}
              max={GENERATOR_LIMITS.restrictions}
              onChange={(value) => set("restrictions", value)}
            />
          </TabsContent>
        </Tabs>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Button
          id={GEN_IDS.submit}
          variant="primary"
          size="lg"
          className="h-12 w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:border-duck aria-disabled:hover:bg-duck"
          disabled={generating || cooldownLeft > 0 || generation.decision !== null}
          aria-disabled={blocked || undefined}
          aria-describedby="gen-submit-help"
          onClick={generation.generate}
        >
          {generating ? <Spinner size={18} /> : <Icon name="sparkle" size={18} />}{" "}
          {generating ? "Gerando…" : cooldownLeft > 0 ? `Aguarde ${cooldownLeft} s` : again ? "Gerar prompt de novo" : "Gerar prompt personalizado"}
        </Button>
        <p id="gen-submit-help" className={cn("text-[13px]", blocked ? "font-semibold text-warn" : "text-ink-2")}>
          {sentence ??
            (again
              ? "Gera de novo a partir do que está acima. Nada é salvo: o resultado entra como alteração, você testa no simulador e salva."
              : "Leva de 20 segundos a 2 minutos. Nada é salvo: o resultado entra como alteração, você testa no simulador e salva.")}
        </p>
        {extraLabels.length > 0 ? (
          <p className="text-xs text-ink-2">Também vamos usar o que você informou antes em: {extraLabels.join(", ")}.</p>
        ) : null}
      </div>
    </div>
  );
}
