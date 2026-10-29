"use client";

import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { GENERATOR_FIELD_LABELS } from "@/lib/agent-generator";
import type { GenerationApi } from "../use-generation";

/**
 * "O que pode melhorar": só leitura. Lista o que a IA apontou como ausente dos dados (e outros pontos que notou) depois de
 * gerar. Não pede nada nem gera de novo: quem sabe a resposta acrescenta no texto da empresa (Configuração avançada) e
 * testa no simulador. Fica embaixo do simulador.
 */
export function ImproveHints({ generation, className }: { generation: GenerationApi; className?: string }) {
  const { outcome } = generation;
  if (!outcome) return null;

  const { missing, notes } = outcome;
  if (missing.length === 0 && notes.length === 0) {
    return (
      <Alert tone="ok" className={className}>
        A IA não apontou nenhuma informação importante faltando. Mesmo assim, confira tudo antes de salvar.
      </Alert>
    );
  }

  return (
    <section aria-labelledby="gen-improve-title" className={cn("flex flex-col gap-3 overflow-y-auto rounded-control bg-warn-bg p-4 text-ink max-sm:p-3.5", className)}>
      <h3 id="gen-improve-title" className="flex items-center gap-2 text-[15px] font-bold text-warn">
        <Icon name="alert" size={18} /> O que pode melhorar
      </h3>
      {missing.length > 0 ? (
        <div>
          <p className="text-[13px]">
            A IA não inventou estes pontos porque não estavam nos seus dados. Se souber, acrescente em “Informações da empresa” (Configuração
            avançada) e teste aqui.
          </p>
          <ul className="mt-1 list-disc pl-5 text-[13px] font-semibold">
            {missing.map((field) => (
              <li key={field}>{GENERATOR_FIELD_LABELS[field]}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div>
          <h4 className="text-[13px] font-bold">Outros pontos que a IA notou</h4>
          <ul className="mt-1 list-disc pl-5 text-[13px]">
            {notes.map((note, index) => (
              <li key={`${index}-${note}`}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
