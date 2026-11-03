"use client";

import type { ContactList, Tag } from "@duckzap/contracts/contacts";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { ConfirmDialog } from "@duckzap/ui/components/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@duckzap/ui/components/dropdown-menu";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatNumber } from "@/lib/format";
import { deleteListAction } from "../actions";
import { describeFilter } from "../labels";
import { NO_PERMISSION_HINT, type ContactPerms } from "../perms";
import { ListFormDialog } from "./list-form-dialog";

export function ListsTab({ lists, tags, perms }: { lists: ContactList[]; tags: Tag[]; perms: ContactPerms }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ContactList | null>(null);

  async function remove(list: ContactList) {
    const result = await deleteListAction(list.id);
    if ("error" in result) return { error: result.error };
    router.refresh();
    return { ok: true } as const;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex-[1_1_320px] text-ink-2">
          Listas estáticas guardam pessoas escolhidas. Segmentos se atualizam sozinhos a partir de um filtro salvo.
        </p>
        <Button variant="primary" onClick={() => setFormOpen(true)} disabled={!perms.organize} title={perms.organize ? undefined : NO_PERMISSION_HINT}>
          <Icon name="plus" size={16} />
          Nova lista
        </Button>
      </div>
      {lists.length === 0 ? (
        <Card>
          <EmptyState
            icon="list"
            title="Nenhuma lista ainda"
            description="Crie uma lista para juntar pessoas ou um segmento para salvar um filtro."
            action={
              perms.organize ? (
                <Button variant="primary" onClick={() => setFormOpen(true)}>
                  <Icon name="plus" size={16} />
                  Nova lista
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
          {lists.map((list) => (
            <li key={list.id}>
              <Card padding="md" className="flex h-full flex-col gap-2.5">
                <div className="flex items-start justify-between gap-2">
                  <strong>{list.name}</strong>
                  <div className="flex items-center gap-1">
                    <Chip tone={list.kind === "segment" ? "info" : "neutral"}>{list.kind === "segment" ? "Segmento" : "Estática"}</Chip>
                    {perms.organize ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" aria-label={`Mais ações de ${list.name}`} className="size-9">
                            <Icon name="more" size={16} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem tone="danger" onSelect={() => setToDelete(list)}>
                            <Icon name="trash" size={16} />
                            Excluir {list.kind === "segment" ? "segmento" : "lista"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </div>
                <p className="text-[28px] font-extrabold">{formatNumber(list.memberCount)}</p>
                <p className="text-ink-2">{list.memberCount === 1 ? "pessoa" : "pessoas"} {list.kind === "segment" ? "agora" : "na lista"}</p>
                <p className="flex-1 text-[13px] text-ink-2">{list.kind === "segment" ? describeFilter(list.filter, tags) : list.description || "—"}</p>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/clientes?lista=${list.id}`} className={buttonVariants({ size: "sm", className: "max-md:h-11" })}>
                    Ver membros
                  </Link>
                  <Link href={`/campanhas?lista=${list.id}`} className={buttonVariants({ size: "sm", variant: "primary", className: "max-md:h-11" })}>
                    Usar em campanha
                  </Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ListFormDialog open={formOpen} onOpenChange={setFormOpen} tags={tags} />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={`Excluir “${toDelete?.name ?? ""}”?`}
        description="Os clientes continuam cadastrados; só a lista some."
        confirmLabel="Excluir"
        pendingLabel="Excluindo…"
        danger
        onConfirm={() => (toDelete ? remove(toDelete) : Promise.resolve({ ok: true } as const))}
      />
    </div>
  );
}
