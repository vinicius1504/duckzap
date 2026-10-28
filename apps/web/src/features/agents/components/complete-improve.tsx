"use client";

import { Alert } from "@duckzap/ui/components/feedback";
import { Button } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import { EXTRA_PLACEHOLDERS, GENERATOR_FIELD_LABELS, GENERATOR_LIMITS } from "@/lib/agent-generator";
import { GEN_IDS, type GenerationApi } from "../use-generation";
import { CountedField } from "./field";

/**
 * "Complete para melhorar": só os itens que o gerador apontou como ausentes de TODOS os dados. Cada um tem um campo curto e
 * um botão que gera de novo com o formulário guardado + estes extras, num clique. Os itens somem quando a nova geração
 * termina e o campo passou a ter conteúdo. Avisos em texto livre que não viraram campo aparecem como notas.
 */
export function CompleteImprove({ generation, onUpdate }: { generation: GenerationApi; onUpdate?: () => void }) {
  const { outcome, extras, fieldErrors, generating } = generation;
  if (!outcome) return null;

  const { missing, notes } = outcome;
  if (missing.length === 0 && notes.length === 0) {
    return (
      <Alert tone="ok">
        A IA não apontou nenhuma informação importante faltando. Mesmo assim, confira tudo antes de salvar.
      </Alert>
    );
  }

  return (
    <section aria-labelledby="gen-improve-title" className="flex flex-col gap-4 rounded-control bg-warn-bg p-4 text-ink max-sm:p-3.5">
      <div>
        <h3 id="gen-improve-title" className="flex items-center gap-2 text-[15px] font-bold text-warn">
          <Icon name="alert" size={18} /> Complete para melhorar
        </h3>
        {missing.length > 0 ? (
          <p className="mt-1 text-[13px]">A IA não inventou estes pontos porque não estavam nos seus dados. Responda o que souber e atualize o perfil em um clique.</p>
        ) : null}
      </div>

      {missing.length > 0 ? (
        <fieldset disabled={generating} className="flex min-w-0 flex-col gap-3 border-0 p-0">
          <legend className="sr-only">Informações que faltam</legend>
          {missing.map((field) => (
            <div key={field} className="rounded-control bg-surface p-3">
              <CountedField
                id={GEN_IDS.extra(field)}
                label={GENERATOR_FIELD_LABELS[field]}
                value={extras[field] ?? ""}
                onChange={(value) => generation.setExtra(field, value)}
                max={GENERATOR_LIMITS[field]}
                rows={2}
                placeholder={EXTRA_PLACEHOLDERS[field]}
                error={fieldErrors[field]}
                trimmedCount
              />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" className="max-md:h-11" disabled={generating || generation.filledExtraCount === 0} onClick={onUpdate ?? generation.generate}>
              <Icon name="refresh" size={16} /> Atualizar com estas informações
            </Button>
            <p className="min-w-0 flex-[1_1_220px] text-[13px] text-ink-2">
              {generation.filledExtraCount === 0 ? "Preencha pelo menos um item para atualizar." : "Gera de novo com o que você já escreveu acima e estes itens."}
            </p>
          </div>
        </fieldset>
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
