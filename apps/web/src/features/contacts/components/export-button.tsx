"use client";

import type { ExportRequest } from "@duckzap/contracts/contacts";
import { Button, type ButtonProps } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import { useState, useTransition } from "react";
import { exportContactsAction } from "../actions";

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Exporta em CSV (abre no Excel). Com `request.contactIds` exporta só os selecionados. */
export function ExportButton({
  request,
  label = "Exportar",
  size,
  onDone,
}: {
  request: ExportRequest;
  label?: string;
  size?: ButtonProps["size"];
  onDone?: (count: number) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function run() {
    startTransition(async () => {
      const result = await exportContactsAction(request);
      if ("error" in result) return setMessage({ tone: "err", text: result.error });
      download(result.data.fileName, result.data.csv);
      setMessage({ tone: "ok", text: `${result.data.count} clientes exportados.` });
      onDone?.(result.data.count);
    });
  }

  return (
    <>
      <Button size={size} onClick={run} disabled={pending}>
        <Icon name="download" size={16} />
        {pending ? "Exportando…" : label}
      </Button>
      <span role="status" className={message?.tone === "err" ? "sr-only text-err" : "sr-only"}>
        {message?.text}
      </span>
    </>
  );
}
