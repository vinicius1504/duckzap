"use client";

import { emailError, emailSuggestion, formatPhoneInput, phoneError } from "@duckzap/contracts/validation";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { useState } from "react";

type FieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  /** Mostra o erro mesmo sem ter saído do campo (ex.: depois de tentar salvar). */
  showErrors?: boolean;
  className?: string;
  autoComplete?: string;
  placeholder?: string;
};

/**
 * Telefone com máscara brasileira enquanto digita e aviso ao sair do campo. A regra é a mesma da API
 * (`@duckzap/contracts/validation`); quem salva também confere com `phoneError` antes de enviar.
 */
export function PhoneField({ id, label, value, onChange, required, showErrors, className, autoComplete = "tel", placeholder = "(67) 99812-3456" }: FieldProps) {
  const [touched, setTouched] = useState(false);
  const error = touched || showErrors ? phoneError(value, { required }) : null;
  const errorId = `${id}-erro`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={formatPhoneInput(value)}
        onChange={(e) => onChange(formatPhoneInput(e.target.value))}
        onBlur={() => setTouched(true)}
        invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={className}
      />
      <FieldError id={errorId} message={error ?? undefined} />
    </div>
  );
}

/** E-mail com aviso ao sair do campo e sugestão para erros comuns de domínio (gmial.com → gmail.com). */
export function EmailField({ id, label, value, onChange, required, showErrors, className, autoComplete = "email", placeholder }: FieldProps) {
  const [touched, setTouched] = useState(false);
  const error = touched || showErrors ? emailError(value, { required }) : null;
  const suggestion = touched && !error ? emailSuggestion(value) : null;
  const errorId = `${id}-erro`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="email"
        inputMode="email"
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          setTouched(true);
          const trimmed = value.trim();
          if (trimmed !== value) onChange(trimmed);
        }}
        invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        className={className}
      />
      <FieldError id={errorId} message={error ?? undefined} />
      {suggestion ? (
        <p className="mt-1.5 text-[13px] text-ink-2">
          Quis dizer{" "}
          <button type="button" className="font-semibold text-ink underline" onClick={() => onChange(suggestion)}>
            {suggestion}
          </button>
          ?
        </p>
      ) : null}
    </div>
  );
}
