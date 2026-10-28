"use client";

import { FUNNEL_STAGE_COUNT, tagColorSchema, type Tag, type TagColor } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Radio } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import { cn } from "@duckzap/ui/cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import { deleteTagAction, reorderTagsAction, saveTagAction } from "../actions";
import { tagColorLabel, tagSwatch } from "../labels";
import { NO_PERMISSION_HINT, type ContactPerms } from "../perms";
import { TagSwatch } from "./badges";

export function TagsTab({ tags, perms }: { tags: Tag[]; perms: ContactPerms }) {
  const router = useRouter();
  const [ordered, reorder] = useOptimistic(tags, (_state, next: Tag[]) => next);
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<Tag | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    startTransition(async () => {
      reorder(next.map((t, position) => ({ ...t, position })));
      const result = await reorderTagsAction(next.map((t) => t.id));
      if ("error" in result) setError(result.error);
      else setError(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex-[1_1_320px] text-ink-2">
          As quatro primeiras são as etapas do funil e viram as colunas do Quadro em Conversas. Use as setas para mudar a ordem.
        </p>
        <Button variant="primary" onClick={() => setEditing("new")} disabled={!perms.organize} title={perms.organize ? undefined : NO_PERMISSION_HINT}>
          <Icon name="plus" size={16} />
          Nova etiqueta
        </Button>
      </div>
      {error ? <Alert tone="err" live>{error}</Alert> : null}

      <Card>
        <ol aria-label="Etiquetas em ordem">
          {ordered.map((tag, index) => {
            const stage = index < FUNNEL_STAGE_COUNT;
            return (
              <li
                key={tag.id}
                className={cn(
                  "flex flex-wrap items-center gap-3.5 border-b border-line px-[18px] py-3.5 last:border-0",
                  index === FUNNEL_STAGE_COUNT && "border-t-2 border-t-line",
                )}
              >
                {perms.organize ? (
                  <span className="flex gap-1">
                    <Button size="icon" variant="ghost" className="size-9 max-md:size-11" aria-label={`Subir ${tag.name}`} disabled={index === 0} onClick={() => move(index, -1)}>
                      <Icon name="chevronDown" size={16} className="rotate-180" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-9 max-md:size-11"
                      aria-label={`Descer ${tag.name}`}
                      disabled={index === ordered.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <Icon name="chevronDown" size={16} />
                    </Button>
                  </span>
                ) : null}
                <TagSwatch tag={tag} className="size-4 rounded-[5px]" />
                <strong className="w-32">{tag.name}</strong>
                <span className="flex-[1_1_200px] text-ink-2">{tag.description || "—"}</span>
                <Chip tone={stage ? "info" : "neutral"}>{stage ? `Etapa ${index + 1}` : "Etiqueta livre"}</Chip>
                <Link href={`/clientes?etiqueta=${tag.id}`} className="min-w-24 text-ink-2 underline-offset-2 hover:underline">
                  {tag.contactCount} {tag.contactCount === 1 ? "cliente" : "clientes"}
                </Link>
                {perms.organize ? (
                  <Button size="sm" onClick={() => setEditing(tag)} className="max-md:h-11">
                    Editar
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>

      <TagFormDialog
        tag={editing === "new" ? null : editing}
        open={editing !== null}
        isStage={editing !== null && editing !== "new" && ordered.findIndex((t) => t.id === editing.id) < FUNNEL_STAGE_COUNT}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      />
    </div>
  );
}

function TagFormDialog({
  tag,
  open,
  isStage,
  onOpenChange,
}: {
  tag: Tag | null;
  open: boolean;
  isStage: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<TagColor>("info");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setName(tag?.name ?? "");
      setDescription(tag?.description ?? "");
      setColor(tag?.color ?? "info");
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await saveTagAction(tag?.id ?? null, { name, description, color });
      if ("error" in result) return setError(result.error);
      onOpenChange(false);
      router.refresh();
    });
  }

  function remove() {
    if (!tag) return;
    startTransition(async () => {
      const result = await deleteTagAction(tag.id);
      if ("error" in result) return setError(result.error);
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title={tag ? "Editar etiqueta" : "Nova etiqueta"}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="tag-nome">Nome</Label>
            <Input id="tag-nome" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
          </div>
          <div>
            <Label htmlFor="tag-desc">Descrição</Label>
            <Input id="tag-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} placeholder="Quando usar esta etiqueta" />
          </div>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Cor</legend>
            <div className="flex flex-wrap gap-2">
              {tagColorSchema.options.map((c) => (
                <label key={c} className={cn("flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-line px-3 has-focus-visible:ring-3 has-focus-visible:ring-ink", color === c && "border-ink bg-surface-2")}>
                  <Radio name="tag-color" checked={color === c} onChange={() => setColor(c)} className="sr-only" />
                  <span aria-hidden="true" className={cn("size-4 rounded-[5px]", tagSwatch[c])} />
                  {tagColorLabel[c]}
                </label>
              ))}
            </div>
          </fieldset>
          {isStage ? <p className="text-[13px] text-ink-2">Esta etiqueta é uma etapa do funil. O nome aparece como coluna no Quadro.</p> : null}
          {error ? <Alert tone="err" live>{error}</Alert> : null}
          <DialogFooter className="justify-between">
            {tag ? (
              <Button className="mr-auto text-err" onClick={remove} disabled={pending || isStage} title={isStage ? "Etapas do funil não podem ser excluídas" : undefined}>
                <Icon name="trash" size={16} />
                Excluir
              </Button>
            ) : null}
            <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
