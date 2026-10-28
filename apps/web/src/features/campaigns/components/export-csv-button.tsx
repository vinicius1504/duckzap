"use client";

import { Button } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";

function escape(cell: string | number) {
  const text = String(cell);
  return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Exporta linhas já carregadas como CSV (separador ";" para abrir direto no Excel em pt-BR). */
export function ExportCsvButton({
  filename,
  header,
  rows,
  label = "Exportar",
}: {
  filename: string;
  header: readonly string[];
  rows: readonly (readonly (string | number)[])[];
  label?: string;
}) {
  function download() {
    const csv = [header, ...rows].map((r) => r.map(escape).join(";")).join("\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Button size="sm" onClick={download} aria-label={`${label}: ${filename}`}>
      <Icon name="download" size={16} /> {label}
    </Button>
  );
}
