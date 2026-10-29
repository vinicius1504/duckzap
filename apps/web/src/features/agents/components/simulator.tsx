"use client";

import type { SimulatorMessage, SimulatorReply, AgentConfig } from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { useEffect, useId, useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { simulateAgentAction } from "../actions";
import { toolView } from "../labels";

export type SimulatorEntry =
  | { kind: "message"; message: SimulatorMessage }
  | { kind: "tool"; call: SimulatorReply["toolCalls"][number] }
  | { kind: "handoff"; reason: string };

const examples = ["Vocês aceitam Unimed?", "Quero uma limpeza na sexta", "Quanto custa o clareamento?", "Quero falar com um atendente"];

/**
 * Simulador isolado (§4.3): usa a configuração que está na tela (mesmo sem salvar) e as tools em modo de teste.
 * Nunca envia mensagem a clientes nem grava agendamento.
 */
export function Simulator({
  agentId,
  agentName,
  config,
  dirty,
  entries,
  setEntries,
  className,
}: {
  agentId: string;
  agentName: string;
  config: AgentConfig;
  dirty: boolean;
  /** Ajuste de altura: na coluna fixa, o aviso "O que pode melhorar" divide a altura da tela com o simulador. */
  className?: string;
  /** A conversa de teste mora no editor: a gaveta (abaixo de `xl`) e a coluna fixa mostram a mesma, e ela sobrevive a fechar a gaveta. */
  entries: SimulatorEntry[];
  setEntries: Dispatch<SetStateAction<SimulatorEntry[]>>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const listRef = useRef<HTMLOListElement>(null);
  const inputId = useId();

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [entries, pending]);

  function send(message: string) {
    const clean = message.trim();
    if (!clean || pending) return;
    const history: SimulatorMessage[] = [
      ...entries.flatMap((e) => (e.kind === "message" ? [e.message] : [])),
      { role: "customer", text: clean },
    ];
    setEntries((list) => [...list, { kind: "message", message: { role: "customer", text: clean } }]);
    setText("");
    setError(null);
    startTransition(async () => {
      const result = await simulateAgentAction(agentId, config, history.slice(-40));
      if (result.error !== undefined) {
        setError(result.error);
        return;
      }
      const reply = result.data;
      setEntries((list) => [
        ...list,
        ...reply.toolCalls.map((call): SimulatorEntry => ({ kind: "tool", call })),
        ...reply.messages.map((m): SimulatorEntry => ({ kind: "message", message: { role: "agent", text: m } })),
        ...(reply.handoff ? [{ kind: "handoff", reason: reply.handoff.reason } satisfies SimulatorEntry] : []),
      ]);
    });
  }

  return (
    <Card className={cn("flex max-h-[calc(100dvh-140px)] min-h-[420px] flex-col gap-0 overflow-hidden p-0 max-xl:max-h-none", className)}>
      <div className="flex items-center justify-between gap-3 bg-duck px-4 py-3 text-on-duck">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full border border-current">
            <Icon name="bot" size={20} />
          </span>
          <div className="min-w-0">
            <strong className="block truncate">{agentName}</strong>
            <p className="flex items-center gap-1.5 text-xs">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ok" />
              Online agora · modo de teste
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setEntries([])} disabled={!entries.length || pending} className="shrink-0 max-md:h-11">
          <Icon name="refresh" size={14} /> Reiniciar
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <p className="text-[13px] text-ink-2">Teste aqui. Nada é enviado a clientes.</p>
      {dirty ? <p className="rounded-control bg-info-bg px-3 py-2 text-xs text-info">Testando as alterações ainda não salvas.</p> : null}

      <ol ref={listRef} className="flex min-h-48 flex-1 flex-col gap-2 overflow-y-auto rounded-control bg-surface-2 p-3" aria-live="polite" aria-label="Conversa de teste">
        {!entries.length ? (
          <li className="m-auto flex flex-col items-center gap-2 text-center text-[13px] text-ink-2">
            <strong className="text-ink">Envie uma mensagem para testar seu agente de IA</strong>
            Escreva como se fosse o cliente ou use um exemplo:
            <span className="flex flex-wrap justify-center gap-1.5">
              {examples.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => send(ex)}
                  className="min-h-9 rounded-full border border-line bg-surface px-3 text-xs font-semibold text-ink hover:bg-surface-hover max-md:min-h-11"
                >
                  {ex}
                </button>
              ))}
            </span>
          </li>
        ) : null}
        {entries.map((e, i) => {
          if (e.kind === "tool")
            return (
              <li key={i} className="self-center rounded-control border border-dashed border-field bg-surface px-2.5 py-1.5 text-xs text-ink-2">
                <span className="flex items-center gap-1.5 font-semibold text-ink">
                  <Icon name="sliders" size={12} /> {toolView[e.call.tool].label}
                  <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-bold text-ink-2">teste</span>
                </span>
                <code className="block break-all">
                  {e.call.tool}({Object.entries(e.call.args).map(([k, v]) => `${k}: "${v}"`).join(", ")})
                </code>
                <span className="block">→ {e.call.result}</span>
              </li>
            );
          if (e.kind === "handoff")
            return (
              <li key={i} className="self-stretch rounded-control bg-warn-bg px-3 py-2 text-[13px] text-warn">
                <strong className="flex items-center gap-1.5">
                  <Icon name="users" size={14} /> Handoff para humano
                </strong>
                {e.reason}. Na vida real, a conversa iria para a fila da equipe e o agente pararia de responder.
              </li>
            );
          const fromAgent = e.message.role === "agent";
          return (
            <li
              key={i}
              className={cn(
                "max-w-[85%] whitespace-pre-line rounded-xl px-3 py-2 text-[13px]",
                fromAgent ? "self-start rounded-tl-sm bg-surface" : "self-end rounded-tr-sm bg-duck text-on-duck",
              )}
            >
              <span className="sr-only">{fromAgent ? `${agentName}: ` : "Cliente: "}</span>
              {e.message.text}
            </li>
          );
        })}
        {pending ? (
          <li className="flex items-center gap-2 self-start rounded-xl bg-surface px-3 py-2 text-[13px] text-ink-2">
            <Spinner size={14} /> {agentName} está digitando…
          </li>
        ) : null}
      </ol>

      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Mensagem de teste
        </label>
        <input
          id={inputId}
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Converse com o Agente ${agentName}…`}
          className="h-11 min-w-0 flex-1 rounded-control border border-field bg-surface px-3 text-ink placeholder:text-ink-2"
        />
        <Button type="submit" variant="primary" size="icon" aria-label="Enviar teste" disabled={!text.trim() || pending} className="size-11">
          <Icon name="send" size={18} />
        </Button>
      </form>
      </div>
    </Card>
  );
}
