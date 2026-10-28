"use client";

import {
  MAX_VARIATIONS,
  MIN_APPROVED_VARIATIONS,
  MIN_VARIATIONS,
  validateVariation,
  type MessageVariation,
} from "@duckzap/contracts/campaigns";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, Spinner } from "@duckzap/ui/components/feedback";
import { Radio, Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useState, useTransition } from "react";
import { generateVariationsAction } from "../../actions";
import { variationIssueLabel } from "../../labels";
import type { StepProps } from "./types";
import { bankIsStale } from "./validate";

const counts = [15, 20, 25, 30].filter((n) => n >= MIN_VARIATIONS && n <= MAX_VARIATIONS);

/** Banco de variações por IA (§5.7 item 4): gerar, revisar e aprovar cada uma antes do disparo. */
export function VariationBank({ draft, update, onPreview }: StepProps & { onPreview: (text: string) => void }) {
  const [count, setCount] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pending, startTransition] = useTransition();
  const { variations } = draft;
  const stale = bankIsStale(draft);
  const approved = variations.filter((v) => v.review === "approved").length;
  const rejected = variations.filter((v) => v.review === "rejected").length;
  const waiting = variations.filter((v) => v.review === "pending").length;
  const flagged = variations.filter((v) => v.issues.length && v.review !== "rejected").length;

  function generate() {
    setError(null);
    startTransition(async () => {
      const result = await generateVariationsAction({ base: draft.message.body, optOutLine: draft.message.optOutLine, count });
      if (result.error !== undefined) setError(result.error);
      else update({ variations: result.data, variationsBase: draft.message.body });
    });
  }

  function setVariations(next: MessageVariation[]) {
    update({ variations: next });
  }

  function review(id: string, value: MessageVariation["review"]) {
    setVariations(variations.map((v) => (v.id === id ? { ...v, review: value } : v)));
  }

  function approveClean() {
    setVariations(variations.map((v) => (v.review === "pending" && !v.issues.length ? { ...v, review: "approved" } : v)));
  }

  function rejectFlagged() {
    setVariations(variations.map((v) => (v.review === "pending" && v.issues.length ? { ...v, review: "rejected" } : v)));
  }

  function saveEdit(id: string) {
    const others = variations.filter((v) => v.id !== id).map((v) => v.text);
    const issues = validateVariation(draft.message.body, draft.message.optOutLine, editText, others);
    setVariations(variations.map((v) => (v.id === id ? { ...v, text: editText, issues, review: "pending" } : v)));
    setEditing(null);
  }

  return (
    <section aria-labelledby="bank-title" className="flex flex-col gap-4 rounded-card border border-line p-4">
      <div>
        <h3 id="bank-title" className="flex items-center gap-2 font-bold">
          <Icon name="sparkle" size={18} /> Banco de variações
        </h3>
        <p className="mt-1 text-[13px] text-ink-2">
          A IA reescreve sua mensagem com o mesmo sentido, para nenhuma sair igual. Um validador confere variáveis, links e a linha de
          saída. Você revisa e aprova cada uma; só as aprovadas são sorteadas no envio.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="bank-count">Quantidade</Label>
          <Select id="bank-count" value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-28">
            {counts.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <Button variant={variations.length && !stale ? "secondary" : "primary"} disabled={pending} onClick={generate}>
          {pending ? <Spinner size={16} /> : <Icon name="sparkle" size={16} />}
          {pending ? "Gerando…" : variations.length ? "Gerar de novo" : "Gerar variações"}
        </Button>
      </div>

      {error ? (
        <Alert tone="err" live>
          {error}
        </Alert>
      ) : null}
      {stale ? (
        <Alert tone="warn" title="A mensagem base mudou.">
          Gere as variações de novo para que elas sigam o texto atual.
        </Alert>
      ) : null}

      {variations.length ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px]" aria-live="polite">
            <Chip tone="ok">{approved} aprovadas</Chip>
            <Chip>{waiting} pendentes</Chip>
            <Chip>{rejected} rejeitadas</Chip>
            {flagged ? <Chip tone="err">{flagged} com alerta</Chip> : null}
            <span className="text-ink-2">Mínimo para enviar: {MIN_APPROVED_VARIATIONS} aprovadas.</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={approveClean} disabled={!variations.some((v) => v.review === "pending" && !v.issues.length)}>
              <Icon name="check" size={16} /> Aprovar as sem alerta
            </Button>
            <Button size="sm" variant="ghost" onClick={rejectFlagged} disabled={!variations.some((v) => v.review === "pending" && v.issues.length)}>
              Rejeitar as com alerta
            </Button>
          </div>
          <ol className="flex max-h-[520px] flex-col gap-2 overflow-y-auto pr-1">
            {variations.map((v, i) => (
              <li
                key={v.id}
                className={cn(
                  "rounded-control border border-line p-3",
                  v.review === "approved" && "border-ok",
                  v.review === "rejected" && "opacity-60",
                )}
              >
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink-2">Variação {i + 1}</span>
                  {v.review === "approved" ? <Chip tone="ok">Aprovada</Chip> : v.review === "rejected" ? <Chip>Rejeitada</Chip> : <Chip tone="info">Revisar</Chip>}
                </div>
                {editing === v.id ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor={`var-edit-${v.id}`} className="sr-only">
                      Editar variação {i + 1}
                    </label>
                    <Textarea id={`var-edit-${v.id}`} rows={4} value={editText} onChange={(e) => setEditText(e.target.value)} />
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => saveEdit(v.id)}>
                        Salvar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-line text-[13px]">{v.text}</p>
                )}
                {v.issues.length ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Alertas do validador">
                    {v.issues.map((issue) => (
                      <li key={issue}>
                        <Chip tone="err">
                          <Icon name="alert" size={12} /> {variationIssueLabel[issue]}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {editing !== v.id ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant={v.review === "approved" ? "primary" : "secondary"}
                      aria-pressed={v.review === "approved"}
                      disabled={v.issues.length > 0}
                      title={v.issues.length ? "Corrija os alertas antes de aprovar" : undefined}
                      onClick={() => review(v.id, v.review === "approved" ? "pending" : "approved")}
                      className="max-md:h-11"
                    >
                      <Icon name="thumbUp" size={14} /> Aprovar
                    </Button>
                    <Button
                      size="sm"
                      aria-pressed={v.review === "rejected"}
                      onClick={() => review(v.id, v.review === "rejected" ? "pending" : "rejected")}
                      className="max-md:h-11"
                    >
                      <Icon name="thumbDown" size={14} /> Rejeitar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(v.id);
                        setEditText(v.text);
                      }}
                      className="max-md:h-11"
                    >
                      <Icon name="edit" size={14} /> Editar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onPreview(v.text)} className="max-md:h-11">
                      <Icon name="eye" size={14} /> Ver no celular
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>

          <fieldset className="flex flex-col gap-2 border-t border-line pt-3">
            <legend className="mb-1 text-[13px] font-semibold">Como usar as variações</legend>
            <label className="flex min-h-11 items-start gap-2.5">
              <Radio name="variation-mode" checked={draft.variationMode === "bank"} onChange={() => update({ variationMode: "bank" })} className="mt-0.5" />
              <span>
                <strong>Sortear do banco aprovado</strong> (recomendado)
                <span className="block text-[13px] text-ink-2">Nunca repete a mesma variação em mensagens seguidas. Tudo que sai foi revisado por você.</span>
              </span>
            </label>
            <label className="flex min-h-11 items-start gap-2.5">
              <Radio
                name="variation-mode"
                checked={draft.variationMode === "per_message"}
                onChange={() => update({ variationMode: "per_message" })}
                className="mt-0.5"
              />
              <span>
                <strong>Variação nova a cada mensagem</strong>
                <span className="block text-[13px] text-ink-2">
                  Cada envio ganha um texto novo, conferido pelo validador. Se falhar duas vezes, usa uma do banco aprovado.
                </span>
              </span>
            </label>
          </fieldset>
        </>
      ) : (
        <p className="rounded-control bg-surface-2 p-3 text-[13px] text-ink-2">
          Escreva a mensagem base e gere de {MIN_VARIATIONS} a {MAX_VARIATIONS} variações.
        </p>
      )}
    </section>
  );
}
