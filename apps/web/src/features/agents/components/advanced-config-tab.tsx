"use client";

import { Button } from "@duckzap/ui/components/button";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { useEffect, useState } from "react";
import { hasLegacyCompany, joinLegacyCompany } from "@/lib/agent-company-info";
import type { AgentConfig } from "@duckzap/contracts/agents";
import { examplesCountLabel, incompleteExamples } from "@/lib/agent-examples";
import { GENERATED_NOTICE, PROFILE_LIMITS } from "@/lib/agent-generator-apply";
import { GEN_IDS, type GenerationApi } from "../use-generation";
import { CompleteImprove } from "./complete-improve";
import { ExamplesEditor } from "./examples-editor";
import { CountedField } from "./field";

/**
 * Aviso de que o perfil gerado entrou no agente como alteração NÃO salva. Fica no topo da Configuração avançada, onde
 * moram os textos gerados; o foco vem para cá depois de gerar. Abaixo de `xl` o simulador fica numa gaveta, então o aviso
 * traz o botão que a abre.
 */
function GeneratedNotice({ onOpenSimulator }: { onOpenSimulator: () => void }) {
  return (
    <div id={GEN_IDS.notice} tabIndex={-1} className="outline-none">
      <Alert
        tone="info"
        action={
          <Button size="sm" className="xl:hidden max-md:h-11" onClick={onOpenSimulator}>
            <Icon name="chat" size={14} /> Testar agora
          </Button>
        }
      >
        <strong>{GENERATED_NOTICE}</strong> Os textos abaixo foram escritos pela IA com o que você informou: leia e edite o que quiser.
      </Alert>
    </div>
  );
}

/**
 * Seção "Configuração avançada": três textos grandes — Informações da empresa, Objetivos e instruções, Restrições — e,
 * recolhidos, os Exemplos de resposta. É o mesmo estado da tela; o prompt gerado cai aqui.
 */
export function AdvancedConfigTab({
  config,
  setConfig,
  generation,
  noticeVisible,
  onOpenSimulator,
}: {
  config: AgentConfig;
  setConfig: (next: AgentConfig) => void;
  generation: GenerationApi;
  noticeVisible: boolean;
  onOpenSimulator: () => void;
}) {
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [joinedTruncated, setJoinedTruncated] = useState(false);
  const examples = config.knowledge.examples ?? [];
  const legacy = hasLegacyCompany(config);

  // um exemplo pela metade (ao salvar o editor leva o foco até ele) precisa estar à vista
  const hasIncomplete = incompleteExamples(examples).length > 0;
  useEffect(() => {
    if (hasIncomplete) setExamplesOpen(true);
  }, [hasIncomplete]);

  function joinLegacy() {
    const joined = joinLegacyCompany(config);
    setConfig(joined.config);
    setJoinedTruncated(joined.truncated);
  }

  return (
    <div className="flex flex-col gap-6">
      {noticeVisible ? <GeneratedNotice onOpenSimulator={onOpenSimulator} /> : null}
      <CompleteImprove generation={generation} />

      <div className="flex flex-col gap-3">
        {legacy ? (
          <Alert
            tone="warn"
            title="Este agente usa o formato antigo"
            action={
              <Button size="sm" className="max-md:h-11" onClick={joinLegacy}>
                Juntar em um texto
              </Button>
            }
          >
            O resumo, os produtos e serviços e as perguntas frequentes estão em campos separados. Juntar cria um texto só aqui embaixo, com uma seção
            para cada um, e esvazia os campos antigos. Nada muda até você clicar.
          </Alert>
        ) : null}
        {joinedTruncated ? (
          <Alert tone="warn" live>
            O texto juntado passava do limite e foi cortado no fim. Confira se algo importante ficou de fora.
          </Alert>
        ) : null}
        <CountedField
          id="ag-company-info"
          label="Informações da empresa"
          rows={14}
          value={config.knowledge.companyInfo ?? ""}
          max={PROFILE_LIMITS.companyInfo}
          onChange={(companyInfo) => setConfig({ ...config, knowledge: { ...config.knowledge, companyInfo } })}
          help="Tudo o que o agente precisa saber: serviços, preços, horários, pagamento e perguntas frequentes."
        />
      </div>

      <div className="flex flex-col gap-4">
        <CountedField
          id="ag-description"
          label="Papel do agente (uma frase, opcional)"
          single
          value={config.profile.description}
          max={PROFILE_LIMITS.description}
          placeholder="Ex.: Recebe os clientes e agenda a avaliação."
          help="Resume o que o agente faz; também aparece na lista de agentes."
          onChange={(description) => setConfig({ ...config, profile: { ...config.profile, description } })}
        />
        <CountedField
          id="ag-prompt"
          label="Objetivos e instruções"
          rows={16}
          value={config.advanced.prompt}
          max={PROFILE_LIMITS.instructions}
          help="O roteiro que a IA segue em toda conversa; regras de segurança do sistema valem mesmo que não estejam aqui."
          onChange={(prompt) => setConfig({ ...config, advanced: { ...config.advanced, prompt } })}
        />
      </div>

      <CountedField
        id="ag-restrictions"
        label="Restrições"
        rows={8}
        value={config.advanced.restrictions ?? ""}
        max={PROFILE_LIMITS.restrictions}
        help="O que a IA NÃO deve fazer ou dizer, uma regra por linha."
        onChange={(restrictions) => setConfig({ ...config, advanced: { ...config.advanced, restrictions } })}
      />

      <section aria-labelledby="ag-examples-toggle" className="rounded-control border border-line">
        <h3 id="ag-examples-toggle">
          <button
            type="button"
            aria-expanded={examplesOpen}
            aria-controls="ag-examples-body"
            onClick={() => setExamplesOpen(!examplesOpen)}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-control px-3.5 py-2 text-left hover:bg-surface-hover"
          >
            <span>
              <span className="font-bold">Exemplos de resposta</span> <span className="font-normal text-ink-2">(opcional)</span>
              <span className="ml-2 text-xs font-semibold text-ink-2">{examplesCountLabel(examples.length)}</span>
            </span>
            <Icon name="chevronDown" size={18} className={examplesOpen ? "shrink-0 rotate-180" : "shrink-0"} />
          </button>
        </h3>
        {examplesOpen ? (
          <div id="ag-examples-body" className="border-t border-line p-3.5">
            <ExamplesEditor idPrefix="ag-ex" value={examples} onChange={(next) => setConfig({ ...config, knowledge: { ...config.knowledge, examples: next } })} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
