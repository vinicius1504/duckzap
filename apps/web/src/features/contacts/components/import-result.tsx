"use client";

import type { ImportResult } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";

const skipLabel = { no_phone: "sem telefone", invalid_phone: "telefone inválido", duplicate: "repetido" } as const;

/** Passo "Pronto" das importações (planilha e WhatsApp). `rowLabel` diz como chamar o item ("Linha 3" / "Contato 3"). */
export function ImportResultStep({ result, rowLabel, onClose }: { result: ImportResult; rowLabel: string; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="ok" title="Importação concluída">
        {result.created} novos · {result.updated} atualizados · {result.skipped.length} ignorados
      </Alert>
      {result.skipped.length ? (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[13px] text-ink-2">
          {result.skipped.map((s) => (
            <li key={s.row}>
              {rowLabel} {s.row}: {skipLabel[s.reason]}
            </li>
          ))}
        </ul>
      ) : null}
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          Ver clientes
        </Button>
      </DialogFooter>
    </div>
  );
}
