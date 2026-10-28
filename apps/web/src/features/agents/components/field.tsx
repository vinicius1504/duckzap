import { Textarea } from "@duckzap/ui/components/form-controls";
import { FieldError, Input, Label } from "@duckzap/ui/components/input";
import { CharCounter } from "./char-counter";

/**
 * Campo de texto do editor do agente: rótulo, contador, ajuda e erro ligados por `aria-describedby`.
 * O contador conta o texto como está (o limite é do campo); quem decide aparar é quem salva.
 */
export function CountedField({
  id,
  label,
  value,
  onChange,
  max,
  rows = 4,
  single = false,
  help,
  error,
  placeholder,
  disabled,
  required,
  onBlur,
  mono = false,
  trimmedCount = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  rows?: number;
  /** Uma linha (`Input`) em vez de área de texto. */
  single?: boolean;
  help?: string;
  error?: string | undefined;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  onBlur?: () => void;
  mono?: boolean;
  /** Conta sem os espaços das pontas (o contrato do gerador aceita isso). */
  trimmedCount?: boolean;
}) {
  const describedBy = [help ? `${id}-help` : null, `${id}-count`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  const length = trimmedCount ? value.trim().length : value.length;
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
        <Label htmlFor={id} className="mb-0">
          {label}
          {required ? (
            <>
              <span aria-hidden="true" className="ml-0.5 text-err">
                *
              </span>
              <span className="sr-only"> (obrigatório)</span>
            </>
          ) : null}
        </Label>
        <CharCounter id={`${id}-count`} length={length} max={max} />
      </div>
      {single ? (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          invalid={Boolean(error)}
          aria-required={required || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Textarea
          id={id}
          rows={rows}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          invalid={Boolean(error)}
          aria-required={required || undefined}
          aria-describedby={describedBy}
          className={mono ? "font-mono text-[13px]" : undefined}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help ? (
        <p id={`${id}-help`} className="mt-1 text-xs text-ink-2">
          {help}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
