"use client";

import { consentFilterSchema, type ContactFilter, type ContactListKind, type Tag } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Radio, Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { createListAction } from "../actions";
import { consentView, describeFilter } from "../labels";

const months = Array.from({ length: 12 }, (_, i) => ({
  value: i + 1,
  label: new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, i, 15))),
}));

/** Nova lista estática ou segmento dinâmico (filtro salvo). */
export function ListFormDialog({
  open,
  onOpenChange,
  tags,
  initialKind = "static",
  initialFilter = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: Tag[];
  initialKind?: ContactListKind;
  initialFilter?: ContactFilter | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ContactListKind>(initialKind);
  const [filter, setFilter] = useState<ContactFilter>(initialFilter ?? {});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setKind(initialKind);
      setFilter(initialFilter ?? {});
      setError(null);
    }
    // só ao abrir: não apaga o que a pessoa já digitou se a página recarregar por trás
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await createListAction({ name, description, kind, filter: kind === "segment" ? filter : null });
      if ("error" in result) return setError(result.error);
      onOpenChange(false);
      router.refresh();
    });
  }

  function patch(next: Partial<ContactFilter>) {
    setFilter((f) => ({ ...f, ...next }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={kind === "segment" ? "Novo segmento" : "Nova lista"}
        description="Listas estáticas guardam pessoas escolhidas. Segmentos se atualizam sozinhos a partir de um filtro salvo."
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Tipo</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { value: "static", title: "Lista estática", hint: "Você escolhe quem entra (ações em massa ou importação)." },
                  { value: "segment", title: "Segmento", hint: "Entra quem combina com o filtro, sempre atualizado." },
                ] as const
              ).map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-control border border-line p-3",
                    kind === option.value && "border-ink bg-surface-2",
                  )}
                >
                  <Radio name="kind" checked={kind === option.value} onChange={() => setKind(option.value)} className="mt-0.5" />
                  <span>
                    <strong className="block">{option.title}</strong>
                    <span className="text-[13px] text-ink-2">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <Label htmlFor="lista-nome">Nome</Label>
            <Input id="lista-nome" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Ex.: Pacientes de retorno" />
          </div>
          <div>
            <Label htmlFor="lista-desc">Descrição (opcional)</Label>
            <Textarea id="lista-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={160} />
          </div>

          {kind === "segment" ? (
            <fieldset className="flex flex-col gap-3 rounded-control border border-line p-3">
              <legend className="px-1 text-[13px] font-semibold">Filtro do segmento</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="seg-tag">Etiqueta</Label>
                  <Select id="seg-tag" value={filter.tagId ?? ""} onChange={(e) => patch({ tagId: e.target.value || undefined })}>
                    <option value="">Qualquer</option>
                    {tags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="seg-cliente">É cliente</Label>
                  <Select
                    id="seg-cliente"
                    value={filter.isCustomer === undefined ? "" : filter.isCustomer ? "sim" : "nao"}
                    onChange={(e) => patch({ isCustomer: e.target.value === "" ? undefined : e.target.value === "sim" })}
                  >
                    <option value="">Tanto faz</option>
                    <option value="sim">Sim</option>
                    <option value="nao">Não</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="seg-consent">Disparos</Label>
                  <Select
                    id="seg-consent"
                    value={filter.consent ?? ""}
                    onChange={(e) => {
                      const parsed = consentFilterSchema.safeParse(e.target.value);
                      patch({ consent: parsed.success ? parsed.data : undefined });
                    }}
                  >
                    <option value="">Qualquer</option>
                    {consentFilterSchema.options.map((c) => (
                      <option key={c} value={c}>
                        {consentView[c].short}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="seg-inativo">Sem conversa há</Label>
                  <Select
                    id="seg-inativo"
                    value={filter.inactiveDays ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      patch({ inactiveDays: v === 30 || v === 90 || v === 180 ? v : undefined });
                    }}
                  >
                    <option value="">Qualquer</option>
                    <option value="30">30 dias</option>
                    <option value="90">90 dias</option>
                    <option value="180">180 dias</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="seg-mes">Mês de nascimento</Label>
                  <Select
                    id="seg-mes"
                    value={filter.birthMonth ?? ""}
                    onChange={(e) => patch({ birthMonth: e.target.value ? Number(e.target.value) : undefined })}
                  >
                    <option value="">Qualquer</option>
                    {months.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <p className="text-[13px] text-ink-2">{describeFilter(filter, tags)}</p>
              {filter.consent !== "granted" ? (
                <p className="text-[13px] text-ink-2">Dica: para usar em campanha, inclua “Disparos: Aceita”. Só quem aceitou recebe.</p>
              ) : null}
            </fieldset>
          ) : null}

          {error ? <Alert tone="err" live>{error}</Alert> : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Salvando…" : kind === "segment" ? "Salvar segmento" : "Criar lista"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
