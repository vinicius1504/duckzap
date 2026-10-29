"use client";

import type { AgentGeneratorPurpose, AgentConfig } from "@duckzap/contracts/agents";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GENERATOR_FIELD_LABELS,
  SIMPLE_FIELDS,
  failure as makeFailure,
  firstErrorField,
  formFromConfig,
  formToInput,
  isGeneratorField,
  validateGeneratorForm,
  viewOutcome,
  type GenerateFailure,
  type GenerationOutcomeView,
  type GeneratorFieldErrors,
  type GeneratorTextField,
} from "@/lib/agent-generator";
import { applyGeneratedProfile, toGeneratedProfile, type GeneratedProfile } from "@/lib/agent-generator-apply";
import { gateDestination, requestGeneration } from "./generate-client";

/** Pedido de foco: o `n` muda a cada pedido, então pedir o mesmo id duas vezes funciona. */
export type FocusRequest = { id: string; n: number };

/** Ids dos elementos que recebem foco por programa (a tela os usa nos próprios componentes). */
export const GEN_IDS = {
  submit: "gen-submit",
  progress: "gen-progress",
  failure: "gen-failure",
  notice: "gen-notice",
  field: (name: string) => `gen-${name}`,
} as const;

export type GenerationApi = ReturnType<typeof useGeneration>;

/**
 * Geração do perfil dentro do editor. O estado vive no editor (não na aba): trocar de aba no meio da espera não perde
 * nada. A configuração em edição é a fonte do formulário; este hook só lê dela, chama a rota e coloca o resultado direto
 * no agente como alteração NÃO salva (`updateConfig`), sem perguntar: "Cancelar alterações" desfaz. Quem salva é o
 * "Salvar" do editor.
 */
export function useGeneration({
  config,
  updateConfig,
  fallbackPurpose,
  showTab,
  onApplied,
}: {
  config: AgentConfig;
  updateConfig: (change: (current: AgentConfig) => AgentConfig) => void;
  fallbackPurpose: AgentGeneratorPurpose;
  /** Leva a tela até a seção que tem o campo com erro. */
  showTab: (section: "simples" | "avancada") => void;
  /** O perfil gerado entrou na configuração: o editor vai para "Prompt da empresa" e mostra o aviso. */
  onApplied: () => void;
}) {
  const router = useRouter();
  const configRef = useRef(config);
  configRef.current = config;

  const [generating, setGenerating] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [failure, setFailure] = useState<GenerateFailure | null>(null);
  const [fieldErrors, setFieldErrors] = useState<GeneratorFieldErrors>({});
  const [cooldown, setCooldown] = useState<{ startedAt: number; seconds: number } | null>(null);
  const [outcome, setOutcome] = useState<GenerationOutcomeView | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const focusCounter = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const focus = useCallback((id: string) => {
    focusCounter.current += 1;
    setFocusRequest({ id, n: focusCounter.current });
  }, []);
  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);

  /**
   * Marca os campos com erro e leva o foco ao primeiro. Os campos do formulário simples ficam na Configuração simples.
   * Erro num campo guardado que não tem campo na tela (informações extras de uma geração anterior) vira uma mensagem
   * geral (senão o dono não saberia o que corrigir).
   */
  function showFieldErrors(errors: GeneratorFieldErrors) {
    const onScreen: GeneratorFieldErrors = {};
    const hidden: string[] = [];
    for (const [key, message] of Object.entries(errors)) {
      if (!isGeneratorField(key) || !message) continue;
      const hasInput = key === "purpose" || key === "tone" || (SIMPLE_FIELDS as readonly string[]).includes(key);
      if (hasInput) onScreen[key] = message;
      else hidden.push(`${GENERATOR_FIELD_LABELS[key as GeneratorTextField] ?? key}: ${message}`);
    }
    setFieldErrors(onScreen);
    if (hidden.length > 0) {
      setFailure(makeFailure("invalid_input", { message: `Confira as informações extras guardadas. ${hidden.join(" ")}` }));
      if (!firstErrorField(onScreen)) focus(GEN_IDS.failure);
    }
    const first = firstErrorField(onScreen);
    if (!first) return;
    const target = first === "purpose" || first === "tone" ? "agentName" : first;
    showTab("simples");
    focus(GEN_IDS.field(target));
  }

  function finishApply(profile: GeneratedProfile) {
    updateConfig((current) => applyGeneratedProfile(current, profile));
    setAnnouncement("Perfil gerado e colocado no agente. Nada foi salvo ainda: teste no simulador, ajuste e salve.");
    onApplied();
  }

  async function generate() {
    if (inFlight.current) return;
    const base = configRef.current;
    const values = formFromConfig(base, fallbackPurpose);
    const errors = validateGeneratorForm(values);
    if (Object.keys(errors).length > 0) {
      setFailure(null);
      setAnnouncement("Há campos para corrigir antes de gerar.");
      showFieldErrors(errors);
      return;
    }

    inFlight.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setCancelling(false);
    setFailure(null);
    setFieldErrors({});
    setStartedAt(Date.now());
    setGenerating(true);
    setAnnouncement("Gerando o perfil do agente. Pode levar até 2 minutos.");
    focus(GEN_IDS.progress);

    const result = await requestGeneration(formToInput(values), controller.signal);

    inFlight.current = false;
    abortRef.current = null;
    if (!mounted.current) return;
    setGenerating(false);
    setCancelling(false);

    if (result.ok) {
      setOutcome(viewOutcome(result.data, values));
      setHasGenerated(true);
      finishApply(toGeneratedProfile(result.data));
      return;
    }
    if (result.cancelled) {
      setAnnouncement("Geração cancelada. Seus dados foram mantidos.");
      focus(GEN_IDS.submit);
      return;
    }
    handleFailure(result.error);
  }

  function handleFailure(error: GenerateFailure) {
    if (error.gate) {
      router.push(gateDestination(error.gate));
      return;
    }
    setFailure(error);
    setAnnouncement(error.message);
    if (error.retryAfterSeconds) setCooldown({ startedAt: Date.now(), seconds: error.retryAfterSeconds });
    const fields: GeneratorFieldErrors = {};
    for (const [key, message] of Object.entries(error.fields ?? {})) if (isGeneratorField(key) && message) fields[key] = message;
    if (Object.keys(fields).length > 0) showFieldErrors(fields);
    else focus(GEN_IDS.failure);
  }

  function cancel() {
    setCancelling(true);
    abortRef.current?.abort();
  }

  return {
    generating,
    startedAt,
    cancelling,
    failure,
    fieldErrors,
    cooldown,
    outcome,
    hasGenerated,
    announcement,
    focusRequest,
    clearFocusRequest,
    focus,
    generate: () => void generate(),
    cancel,
    clearFieldError: (field: keyof GeneratorFieldErrors) => setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current)),
    /** Esquece resultado e pendências (usado ao descartar alterações ou quando a versão salva muda). */
    reset: () => {
      setOutcome(null);
      setFailure(null);
      setFieldErrors({});
    },
    setFieldErrors,
    announce: setAnnouncement,
  };
}
