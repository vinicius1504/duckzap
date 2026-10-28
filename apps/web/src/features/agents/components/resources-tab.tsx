"use client";

import { agentToolSchema, type AgentConfig, type CopilotOverview } from "@duckzap/contracts/agents";
import { Card } from "@duckzap/ui/components/card";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon, type IconName } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { setToolEnabled, standaloneTools } from "@/lib/agent-resources";
import type { ResourceId } from "@/lib/agent-tabs";
import { respondWhenLabel, toolView } from "../labels";
import { RulesSettings } from "./config-tabs";
import { CopilotCard } from "./copilot-card";

type TabProps = { config: AgentConfig; setConfig: (next: AgentConfig) => void };

/** Cartão de um recurso: o cabeçalho abre e fecha a configuração (acordeão). */
function ResourceCard({
  id,
  icon,
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  icon: IconName;
  title: string;
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <h3 className="p-3.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => onOpenChange(!open)}
          className="flex min-h-11 w-full items-center gap-3 rounded-control text-left hover:bg-surface-hover"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-ink-2">
            <Icon name={icon} size={18} />
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block font-bold">{title}</span>
            <span className="block text-[13px] text-ink-2">{summary}</span>
          </span>
          <Icon name="chevronDown" size={18} className={open ? "shrink-0 rotate-180" : "shrink-0"} />
        </button>
      </h3>
      {open ? (
        <div id={`${id}-body`} className="border-t border-line p-4 max-sm:p-3.5">
          {children}
        </div>
      ) : null}
    </Card>
  );
}

/** Ferramentas da IA. As de agenda e de retomada não aparecem: agendamento é automático e o follow-up é um agente do sistema. */
function ToolsSettings({ config, setConfig }: TabProps) {
  const tools = config.advanced.tools;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1.5 text-[13px] font-semibold">Ferramentas que o agente pode usar</legend>
      {standaloneTools(agentToolSchema.options).map((tool) => {
        const locked = tool === "request_human";
        return (
          <label key={tool} className="flex min-h-11 items-start gap-2.5 py-1">
            <Checkbox className="mt-0.5" checked={locked || tools.includes(tool)} disabled={locked} onChange={(e) => setConfig(setToolEnabled(config, tool, e.target.checked))} />
            <span>
              <span className="font-semibold">{toolView[tool].label}</span>
              <span className="block text-xs text-ink-2">{toolView[tool].hint}</span>
            </span>
          </label>
        );
      })}
      <p className="text-xs text-ink-2">O agente nunca envia para outro número, lê outra conversa, muda preços, campanhas ou configurações.</p>
    </fieldset>
  );
}

/**
 * Seção "Recursos" (colocação provisória): Regras de atendimento, Ferramentas da IA e Copiloto, cada um num cartão, mais duas
 * linhas informativas — agendamento é automático (vem da Agenda) e o follow-up automático é configurado na página Agentes.
 */
export function ResourcesTab({
  config,
  setConfig,
  copilot,
  copilotAvailable,
  timeZone,
  initialOpen,
}: TabProps & {
  copilot: CopilotOverview;
  copilotAvailable: boolean;
  timeZone: string;
  /** Cartão que um link antigo (`?aba=comportamento`) quer ver aberto. */
  initialOpen: ResourceId | null;
}) {
  const [openIds, setOpenIds] = useState<ReadonlySet<ResourceId>>(() => new Set(initialOpen ? [initialOpen] : []));
  const bind = (id: ResourceId) => ({
    open: openIds.has(id),
    onOpenChange: (open: boolean) =>
      setOpenIds((current) => {
        const next = new Set(current);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">Recursos opcionais do agente. As alterações entram no “Salvar” como o resto.</p>

      <ResourceCard id="res-rules" icon="sliders" title="Regras de atendimento" summary={respondWhenLabel[config.behavior.respondWhen]} {...bind("rules")}>
        <RulesSettings config={config} setConfig={setConfig} />
      </ResourceCard>

      <ResourceCard id="res-tools" icon="bot" title="Ferramentas da IA" summary="O que o agente pode fazer durante a conversa" {...bind("tools")}>
        <ToolsSettings config={config} setConfig={setConfig} />
      </ResourceCard>

      <CopilotCard copilot={copilot} available={copilotAvailable} timeZone={timeZone} />

      <ul className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        <li className="flex items-start gap-2">
          <Icon name="calendar" size={16} className="mt-0.5 shrink-0" />
          <span>
            Agendamento é automático: qualquer agente pode marcar horários quando há tipos de atendimento cadastrados na Agenda.{" "}
            <Link href="/agenda" className="font-semibold text-ink underline underline-offset-2">
              Abrir a Agenda
            </Link>
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Icon name="clock" size={16} className="mt-0.5 shrink-0" />
          <span>
            O follow-up automático é configurado no topo da página{" "}
            <Link href="/agentes" className="font-semibold text-ink underline underline-offset-2">
              Agentes
            </Link>
            .
          </span>
        </li>
      </ul>
    </div>
  );
}
