"use client";

import {
  RELATIONSHIP_CONFIRMATION,
  importFieldSchema,
  type ContactList,
  type ImportField,
  type ImportPreview,
  type ImportResult,
  type Tag,
} from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Select } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Label } from "@duckzap/ui/components/input";
import { Steps } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { commitImportAction, previewImportAction } from "../actions";
import { importFieldLabel } from "../labels";
import { ImportOriginFields, emptyOriginFields, type OriginFields } from "./import-origin-fields";
import { ImportResultStep } from "./import-result";

const steps = ["Arquivo", "Colunas", "Origem", "Pronto"] as const;

export function ImportDialog({
  open,
  onOpenChange,
  tags,
  lists,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
  lists: ContactList[];
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportField>>({});
  const [fields, setFields] = useState<OriginFields>(emptyOriginFields);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setStep(0);
    setPreview(null);
    setMapping({});
    setFields(emptyOriginFields);
    setResult(null);
    setError(null);
  }

  function change(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function upload(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await previewImportAction(formData);
      if ("error" in res) return setError(res.error);
      setPreview(res.data);
      setMapping(Object.fromEntries(res.data.columns.map((c) => [c.key, c.suggested])));
      setStep(1);
    });
  }

  const mapped = Object.values(mapping);
  const mappingError = !mapped.includes("name")
    ? "Escolha a coluna do nome."
    : !mapped.includes("phone")
      ? "Escolha a coluna do telefone."
      : mapped.filter((f) => f === "phone").length > 1 || mapped.filter((f) => f === "name").length > 1
        ? "Nome e telefone só podem vir de uma coluna cada."
        : null;

  function commit() {
    const origin = fields.origin;
    if (!preview || !origin) return;
    setError(null);
    startTransition(async () => {
      if (!fields.confirmed) return setError(`Confirme: “${RELATIONSHIP_CONFIRMATION}”.`);
      const res = await commitImportAction({
        importId: preview.importId,
        mapping,
        origin,
        originNote: fields.originNote,
        confirmedRelationship: true,
        tagIds: fields.tagIds,
        listId: fields.listId || null,
      });
      if ("error" in res) return setError(res.error);
      setResult(res.data);
      setStep(3);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent size="lg" title="Importar planilha" description="Traga seus contatos de uma planilha em CSV.">
        <Steps steps={steps} current={step} label="Etapas da importação" />

        {step === 0 ? (
          <form action={upload} className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-3 rounded-card border-2 border-dashed border-field px-4 py-8 text-center">
              <Icon name="upload" size={28} className="text-ink-2" />
              <label htmlFor="planilha" className="font-semibold">
                Escolha o arquivo
              </label>
              <input id="planilha" name="file" type="file" accept=".csv,.txt" required className="max-w-full text-[13px]" />
              <p className="text-[13px] text-ink-2">Planilha em CSV (no Excel: Arquivo → Salvar como → CSV). Primeira linha com os nomes das colunas. Até 10 MB.</p>
            </div>
            <Alert tone="info">Só importe contatos que têm relação com a sua empresa. Listas compradas não são permitidas.</Alert>
            {error ? <Alert tone="err" live>{error}</Alert> : null}
            <DialogFooter>
              <Button onClick={() => change(false)}>Cancelar</Button>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? "Lendo arquivo…" : "Continuar"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === 1 && preview ? (
          <div className="flex flex-col gap-4">
            <p className="text-ink-2">
              <strong className="text-ink">{preview.fileName}</strong> · {preview.totalRows} linhas. Diga o que cada coluna é.
            </p>
            <ul className="grid gap-3 sm:grid-cols-2">
              {preview.columns.map((column) => (
                <li key={column.key} className="rounded-control border border-line p-3">
                  <Label htmlFor={`map-${column.key}`}>Coluna “{column.header}”</Label>
                  <Select
                    id={`map-${column.key}`}
                    value={mapping[column.key] ?? "ignore"}
                    onChange={(e) => {
                      const parsed = importFieldSchema.safeParse(e.target.value);
                      if (parsed.success) setMapping((m) => ({ ...m, [column.key]: parsed.data }));
                    }}
                  >
                    {importFieldSchema.options.map((f) => (
                      <option key={f} value={f}>
                        {importFieldLabel[f]}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1.5 truncate text-[13px] text-ink-2">
                    Ex.: {preview.sampleRows.map((r) => r[column.key]).filter(Boolean).slice(0, 2).join(", ") || "—"}
                  </p>
                </li>
              ))}
            </ul>
            <div>
              <p className="mb-1.5 text-[13px] font-semibold">Prévia</p>
              <Table minWidth={560}>
                <thead>
                  <tr>
                    {preview.columns.map((c) => (
                      <Th key={c.key}>{importFieldLabel[mapping[c.key] ?? "ignore"]}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sampleRows.map((row, i) => (
                    <tr key={i}>
                      {preview.columns.map((c) => (
                        <Td key={c.key} className={mapping[c.key] === "ignore" ? "text-ink-2 line-through" : undefined}>
                          {row[c.key] || "—"}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
            {mappingError ? <Alert tone="warn">{mappingError}</Alert> : null}
            <DialogFooter>
              <Button onClick={() => setStep(0)}>Voltar</Button>
              <Button variant="primary" disabled={Boolean(mappingError)} onClick={() => setStep(2)}>
                Continuar
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 2 && preview ? (
          <div className="flex flex-col gap-4">
            <ImportOriginFields
              idPrefix="imp"
              tags={tags}
              lists={lists}
              value={fields}
              onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
              showError={Boolean(error)}
            />
            {error ? <Alert tone="err" live>{error}</Alert> : null}
            <DialogFooter>
              <Button onClick={() => setStep(1)}>Voltar</Button>
              <Button variant="primary" disabled={pending || !fields.origin || !fields.confirmed} onClick={commit}>
                {pending ? "Importando…" : `Importar ${preview.totalRows} linhas`}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {step === 3 && result ? <ImportResultStep result={result} rowLabel="Linha" onClose={() => change(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
