"use client";

import { Textarea } from "@duckzap/ui/components/form-controls";
import { FieldError, Label } from "@duckzap/ui/components/input";
import type { TextareaHTMLAttributes } from "react";

/** Campo "Motivo" obrigatório de toda ação do painel (vai para a auditoria). */
export function ReasonField({
  id,
  error,
  length,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { id: string; error?: string; length: number }) {
  const hint = `${id}-dica`;
  const err = `${id}-erro`;
  return (
    <div>
      <Label htmlFor={id}>Motivo</Label>
      <Textarea
        id={id}
        rows={3}
        maxLength={500}
        invalid={Boolean(error)}
        aria-describedby={error ? `${hint} ${err}` : hint}
        placeholder="Ex.: cliente pediu por telefone; combinado com o financeiro."
        {...props}
      />
      <p id={hint} className="mt-1.5 flex justify-between gap-3 text-xs text-ink-2">
        <span>Obrigatório. Fica registrado na auditoria com o seu nome.</span>
        <span aria-hidden="true">{length}/500</span>
      </p>
      <FieldError id={err} message={error} />
    </div>
  );
}
