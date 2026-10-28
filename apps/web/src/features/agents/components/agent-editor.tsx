"use client";

import type { Agent, AgentVersion, CopilotOverview, AgentConfig } from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Dialog, DialogContent } from "@duckzap/ui/components/dialog";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { Tabs, TabsContent } from "@duckzap/ui/components/tabs";
import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { incompleteExamples } from "@/lib/agent-examples";
import {
  GENERATOR_FIELD_LABELS,
  configFingerprint,
  finalizeConfigForSave,
  firstErrorField,
  formFromConfig,
  limitErrors,
  purposeForJob,
  type GeneratorTextField,
} from "@/lib/agent-generator";
import { sectionsWithContent } from "@/lib/agent-generator-apply";
import { AFTER_GENERATION_SECTION, EDITOR_SECTIONS, EXAMPLES_SECTION, legacyResource, parseEditorSection, type EditorSection } from "@/lib/agent-tabs";
import { saveAgentConfigAction, setAgentStatusAction } from "../actions";
import { GEN_IDS, useGeneration } from "../use-generation";
import { AdvancedConfigTab } from "./advanced-config-tab";
import { AgentHeader } from "./agent-header";
import { ApplyConfirmPanel } from "./apply-confirm-panel";
import { GenerationStatus } from "./generation-status";
import { ResourcesTab } from "./resources-tab";
import { SegmentedTabsList, SegmentedTabsTrigger } from "./segmented-tabs";
import { SimpleConfigTab } from "./simple-config-tab";
import { Simulator, type SimulatorEntry } from "./simulator";
import { VersionsDrawer } from "./versions-drawer";

export type TabProps = { config: AgentConfig; setConfig: (next: AgentConfig) => void };

/**
 * Editor do agente (página, não modal), no modelo do MillionZap: cabeçalho com situação e ações, um card com três seções
 * (Configuração simples, Configuração avançada, Recursos) e o simulador fixo à direita (abaixo de `xl`, numa gaveta).
 * A configuração em edição (`config`) é a única fonte de verdade — o formulário do gerador, os textos gerados e os ajustes
 * manuais — e tem um só "Salvar". O simulador testa essa configuração mesmo sem salvar.
 */
export function AgentEditor({
  agent,
  versions,
  copilot,
  copilotAvailable,
  timeZone,
  activationBlocked,
  header,
}: {
  agent: Agent;
  versions: AgentVersion[];
  copilot: CopilotOverview;
  copilotAvailable: boolean;
  timeZone: string;
  /** Motivo de não poder ativar (ex.: recurso fora do plano); null = pode. */
  activationBlocked: string | null;
  /** Parte do cabeçalho que vem do servidor (voltar à lista, avisos de plano). */
  header: ReactNode;
}) {
  const [rawTab, setRawTab] = useQueryState("aba", parseAsString);
  const section = parseEditorSection(rawTab);
  const initialResource = useRef(legacyResource(rawTab)).current;
  const setSection = useCallback((next: EditorSection) => void setRawTab(next), [setRawTab]);

  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [generatedNotice, setGeneratedNotice] = useState(false);
  const [simulatorOpen, setSimulatorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [simulatorEntries, setSimulatorEntries] = useState<SimulatorEntry[]>([]);
  const fallbackPurpose = purposeForJob(agent.job);
  const dirty = configFingerprint(config, fallbackPurpose) !== configFingerprint(agent.config, fallbackPurpose);

  const updateConfig = useCallback((change: (current: AgentConfig) => AgentConfig) => setConfig(change), []);
  const generation = useGeneration({
    config,
    updateConfig,
    fallbackPurpose,
    showTab: setSection,
    onApplied: () => {
      setError(null);
      setNotice(null);
      setGeneratedNotice(true);
      setSection(AFTER_GENERATION_SECTION);
      generation.focus(GEN_IDS.notice);
    },
  });
  const generating = generation.generating;

  // a versão salva mudou (rollback, outra aba): recomeça do servidor
  // (só pela versão: atualizar documentos não pode apagar edições em andamento).
  // Na montagem não faz nada (o estado já nasce da versão salva).
  const savedConfig = agent.config;
  const syncedVersion = useRef(agent.currentVersion);
  useEffect(() => {
    if (syncedVersion.current === agent.currentVersion) return;
    syncedVersion.current = agent.currentVersion;
    setConfig(savedConfig);
    setGeneratedNotice(false);
    generation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.currentVersion]);

  // sair da página com alteração não salva ou geração em andamento pede confirmação ao navegador
  useEffect(() => {
    if (!dirty && !generating) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, generating]);

  // foco por programa (progresso, erro, aviso, campo com problema): espera o elemento existir (a seção pode estar trocando)
  const { focusRequest, clearFocusRequest } = generation;
  useEffect(() => {
    if (!focusRequest) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const element = document.getElementById(focusRequest.id);
      if (element) {
        element.focus();
        clearFocusRequest();
      } else if (tries++ < 12) frame = requestAnimationFrame(attempt);
      else clearFocusRequest();
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, clearFocusRequest]);

  function save(activate: boolean) {
    setError(null);
    setNotice(null);
    const limits = limitErrors(formFromConfig(config, fallbackPurpose));
    const badField = firstErrorField(limits);
    if (badField) {
      const message = limits[badField] ?? "";
      const label = GENERATOR_FIELD_LABELS[badField as GeneratorTextField] ?? badField;
      setError(`${label}: ${message} Corrija na Configuração simples.`);
      generation.setFieldErrors(limits);
      setSection("simples");
      generation.focus(GEN_IDS.field(badField));
      return;
    }
    const bad = incompleteExamples(config.knowledge.examples ?? [])[0];
    if (bad) {
      setError("Há exemplos de resposta incompletos. Preencha os dois lados ou remova o exemplo (Configuração avançada, Exemplos de resposta).");
      setSection(EXAMPLES_SECTION);
      generation.focus(`ag-ex-${bad.index}-${bad.side}`);
      return;
    }
    // exemplos em branco e formulário vazio não vão para a versão salva
    const payload = finalizeConfigForSave(config, fallbackPurpose);
    startTransition(async () => {
      let version = agent.currentVersion;
      if (dirty) {
        const result = await saveAgentConfigAction(agent.id, payload);
        if (result.error !== undefined) return setError(result.error);
        version = result.data.version;
      }
      if (activate) {
        const status = await setAgentStatusAction(agent.id, "active");
        if (status.error !== undefined) return setError(dirty ? `Salvo como versão ${version}, mas não ativou: ${status.error}` : status.error);
      }
      setGeneratedNotice(false);
      setNotice(dirty ? `Salvo como versão ${version}${activate ? " e ativado" : ""}.` : "Agente ativado.");
    });
  }

  function pause() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await setAgentStatusAction(agent.id, "paused");
      if (result.error !== undefined) setError(result.error);
      else setNotice("Agente pausado.");
    });
  }

  function discard() {
    setConfig(agent.config);
    setGeneratedNotice(false);
    generation.reset();
  }

  const tabProps: TabProps = { config, setConfig };
  const openSimulator = () => setSimulatorOpen(true);
  const simulatorProps = { agentId: agent.id, agentName: config.name, config, dirty, entries: simulatorEntries, setEntries: setSimulatorEntries };
  const noticeVisible = generatedNotice && dirty;
  const busy = pending || generating;

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="flex min-w-0 flex-[2_1_520px] flex-col gap-4">
        {header}
        <AgentHeader
          agent={agent}
          name={config.name}
          dirty={dirty}
          busy={busy}
          activationBlocked={activationBlocked}
          onSave={() => save(false)}
          onSaveAndActivate={() => save(true)}
          onPause={pause}
          onDiscard={discard}
          onOpenHistory={() => setHistoryOpen(true)}
        />
        {error ? (
          <Alert tone="err" live>
            {error}
          </Alert>
        ) : null}
        {notice && !dirty ? (
          <Alert tone="ok" live>
            {notice}
          </Alert>
        ) : null}

        <Card className="flex flex-col gap-0 p-5 max-sm:p-4">
          <h2 className="mb-3 text-lg font-bold">Configuração do agente</h2>
          <p role="status" aria-live="polite" className="sr-only">
            {generation.announcement}
          </p>
          <div className="flex flex-col gap-3 empty:hidden [&:not(:empty)]:mb-4">
            <GenerationStatus generation={generation} />
            {generation.decision ? (
              <ApplyConfirmPanel
                config={config}
                sections={sectionsWithContent(config)}
                choices={generation.decision.choices}
                onChoice={generation.setChoice}
                onConfirm={generation.confirmDecision}
                onDiscard={generation.discardDecision}
              />
            ) : null}
          </div>
          <Tabs value={section} onValueChange={(value) => setSection(parseEditorSection(value))}>
            <SegmentedTabsList aria-label="Seções da configuração do agente">
              {EDITOR_SECTIONS.map((item) => (
                <SegmentedTabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </SegmentedTabsTrigger>
              ))}
            </SegmentedTabsList>
            <TabsContent value="simples" className="pt-5">
              <SimpleConfigTab {...tabProps} fallbackPurpose={fallbackPurpose} generation={generation} />
            </TabsContent>
            <TabsContent value="avancada" className="pt-5">
              <AdvancedConfigTab {...tabProps} generation={generation} noticeVisible={noticeVisible} onOpenSimulator={openSimulator} />
            </TabsContent>
            <TabsContent value="recursos" className="pt-5">
              <ResourcesTab
                {...tabProps}
                copilot={copilot}
                copilotAvailable={copilotAvailable}
                timeZone={timeZone}
                initialOpen={initialResource}
              />
            </TabsContent>
          </Tabs>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-[13px] text-ink-2">{dirty ? "Alterações não salvas" : `Versão ${agent.currentVersion} em uso`}</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!dirty || busy} className="max-md:h-11" onClick={discard}>
                Cancelar alterações
              </Button>
              <Button variant="primary" className="max-md:h-11" disabled={!dirty || busy} onClick={() => save(false)}>
                {pending ? <Spinner size={16} /> : null} Salvar
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <aside className="sticky top-4 min-w-0 flex-[1_1_320px] max-xl:hidden" aria-label="Simulador">
        <Simulator {...simulatorProps} />
      </aside>
      <div className="fixed bottom-24 right-4 z-30 xl:hidden">
        <Button variant="primary" size="lg" className="shadow-lg" onClick={openSimulator}>
          <Icon name="chat" size={18} /> Testar no simulador
        </Button>
      </div>
      <Dialog open={simulatorOpen} onOpenChange={setSimulatorOpen}>
        <DialogContent side="right" title="Simulador" description="Teste aqui. Nada é enviado a clientes.">
          <Simulator {...simulatorProps} />
        </DialogContent>
      </Dialog>
      <VersionsDrawer open={historyOpen} onOpenChange={setHistoryOpen} agent={agent} versions={versions} timeZone={timeZone} dirty={dirty} />
    </div>
  );
}
