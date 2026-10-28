"use client";

import { type AgentExample } from "@duckzap/contracts/agents";
import { Button } from "@duckzap/ui/components/button";
import { Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Label } from "@duckzap/ui/components/input";
import { useEffect, useRef, useState } from "react";
import {
  MAX_AGENT_EXAMPLES,
  MAX_EXAMPLE_CHARS,
  addExample,
  canAddExample,
  examplesCountLabel,
  incompleteExamples,
  moveExample,
  removeExample,
  updateExample,
  type ExampleSide,
} from "@/lib/agent-examples";
import { CharCounter } from "./char-counter";

/**
 * Lista editável de exemplos de resposta (`knowledge.examples`). Uma só tela para o editor do agente (aba Conhecimento) e
 * para a revisão do gerador: adicionar, remover e reordenar, no máximo 12 pares e 400 caracteres por lado.
 */
export function ExamplesEditor({
  value,
  onChange,
  idPrefix,
  disabled = false,
  showHelp = true,
}: {
  value: AgentExample[];
  onChange: (next: AgentExample[]) => void;
  /** Prefixo dos ids dos campos (dois editores na mesma tela não podem repetir id). */
  idPrefix: string;
  disabled?: boolean;
  showHelp?: boolean;
}) {
  const [announcement, setAnnouncement] = useState("");
  const focusId = useRef<string | null>(null);
  const problems = incompleteExamples(value);
  const full = !canAddExample(value);

  // depois de adicionar/mover/remover, o foco acompanha o item (a lista é re-renderizada por índice)
  useEffect(() => {
    if (!focusId.current) return;
    document.getElementById(focusId.current)?.focus();
    focusId.current = null;
  });

  const fieldId = (index: number, side: ExampleSide) => `${idPrefix}-${index}-${side}`;

  function add() {
    if (full) return;
    focusId.current = fieldId(value.length, "customer");
    onChange(addExample(value));
    setAnnouncement(`Exemplo ${value.length + 1} adicionado.`);
  }

  function remove(index: number) {
    const next = removeExample(value, index);
    focusId.current = next.length ? fieldId(Math.min(index, next.length - 1), "customer") : `${idPrefix}-add`;
    onChange(next);
    setAnnouncement(`Exemplo ${index + 1} removido. Restam ${next.length}.`);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    // o botão que acabou de ser usado fica desabilitado quando o item chega à ponta: o foco vai para o outro
    const atEdge = direction === -1 ? target === 0 : target === value.length - 1;
    const same = direction === -1 ? "up" : "down";
    focusId.current = `${idPrefix}-${target}-${atEdge ? (same === "up" ? "down" : "up") : same}`;
    onChange(moveExample(value, index, direction));
    setAnnouncement(`Exemplo movido para a posição ${target + 1} de ${value.length}.`);
  }

  return (
    <div className="flex flex-col gap-3">
      {showHelp ? (
        <p className="text-[13px] text-ink-2" id={`${idPrefix}-help`}>
          Exemplos mostram à IA como responder; use perguntas reais dos seus clientes. Ela imita o estilo, não copia o texto.
        </p>
      ) : null}

      {value.length === 0 ? (
        <p className="rounded-control bg-surface-2 p-3 text-[13px] text-ink-2">Nenhum exemplo ainda. Adicione pelo menos alguns para o agente acertar o jeito de responder.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {value.map((example, index) => {
            const missing = (side: ExampleSide) => problems.some((p) => p.index === index && p.side === side);
            return (
              <li key={index}>
                <fieldset disabled={disabled} className="flex flex-col gap-3 rounded-control border border-line p-3.5">
                  <legend className="px-1 text-[13px] font-bold">Exemplo {index + 1}</legend>
                  {(["customer", "agent"] as const).map((side) => {
                    const id = fieldId(index, side);
                    const invalid = missing(side);
                    return (
                      <div key={side}>
                        <div className="mb-1.5 flex items-baseline justify-between gap-2">
                          <Label htmlFor={id} className="mb-0">
                            {side === "customer" ? "O cliente escreve" : "O agente responde"}
                          </Label>
                          <CharCounter id={`${id}-count`} length={example[side].length} max={MAX_EXAMPLE_CHARS} />
                        </div>
                        <Textarea
                          id={id}
                          rows={side === "customer" ? 2 : 3}
                          maxLength={MAX_EXAMPLE_CHARS}
                          value={example[side]}
                          invalid={invalid}
                          aria-describedby={invalid ? `${id}-count ${id}-error` : `${id}-count`}
                          onChange={(e) => onChange(updateExample(value, index, side, e.target.value))}
                        />
                        {invalid ? (
                          <p id={`${id}-error`} className="mt-1 text-[13px] font-semibold text-err">
                            Preencha este lado ou remova o exemplo.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  <div className="flex flex-wrap gap-2">
                    <Button id={`${idPrefix}-${index}-up`} size="sm" className="max-md:h-11" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={`Subir o exemplo ${index + 1}`}>
                      <Icon name="chevronDown" size={16} className="rotate-180" /> Subir
                    </Button>
                    <Button id={`${idPrefix}-${index}-down`} size="sm" className="max-md:h-11" disabled={disabled || index === value.length - 1} onClick={() => move(index, 1)} aria-label={`Descer o exemplo ${index + 1}`}>
                      <Icon name="chevronDown" size={16} /> Descer
                    </Button>
                    <Button size="sm" variant="ghost" className="max-md:h-11" disabled={disabled} onClick={() => remove(index)} aria-label={`Remover o exemplo ${index + 1}`}>
                      <Icon name="trash" size={16} /> Remover
                    </Button>
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button id={`${idPrefix}-add`} className="max-md:h-11" disabled={disabled || full} onClick={add} aria-describedby={full ? `${idPrefix}-full` : undefined}>
          <Icon name="plus" size={16} /> Adicionar exemplo
        </Button>
        <span className="text-[13px] text-ink-2">{examplesCountLabel(value.length)}</span>
        {full ? (
          <span id={`${idPrefix}-full`} className="text-[13px] font-semibold text-warn">
            Limite de {MAX_AGENT_EXAMPLES} exemplos. Remova um para adicionar outro.
          </span>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
