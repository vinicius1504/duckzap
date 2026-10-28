"use client";

import { Button } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useState } from "react";

/** Campo só leitura com botão Copiar (URLs de webhook, tokens, segredos mostrados uma vez). */
export function CopyField({
  id,
  label,
  value,
  mono,
  className,
}: {
  id: string;
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // sem permissão de área de transferência: o usuário seleciona o texto manualmente
      document.getElementById(id)?.focus();
    }
  }

  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={cn("h-10 min-w-0", mono && "font-mono text-[13px]")}
        />
        <Button onClick={copy} className="shrink-0" aria-label={`Copiar ${label.toLowerCase()}`}>
          <Icon name={copied ? "check" : "copy"} size={16} />
          <span className="max-sm:sr-only">{copied ? "Copiado" : "Copiar"}</span>
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} copiado` : ""}
      </span>
    </div>
  );
}
