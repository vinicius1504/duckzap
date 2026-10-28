"use client";

import {
  inviteIneligibility,
  type ContactList,
  type ContactPage,
  type InviteIneligibleReason,
  type InviteOverview,
  type Tag,
} from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@duckzap/ui/components/dropdown-menu";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import { cn } from "@duckzap/ui/cn";
import { useQueryStates } from "nuqs";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatDate, formatPhone } from "@/lib/format";
import { addToListAction, deleteContactsAction, tagContactsAction } from "../actions";
import { NO_PERMISSION_HINT, type ContactPerms } from "../perms";
import { contactsParsers } from "../search-params";
import { ConsentChip, TagChips, TagSwatch } from "./badges";
import { ExportButton } from "./export-button";
import { InviteDialog, type InviteAudience } from "./invite-dialog";

export function ContactsTable({
  page,
  tags,
  lists,
  inviteOverview,
  perms,
  sendingPaused,
  timeZone,
}: {
  page: ContactPage;
  tags: Tag[];
  lists: ContactList[];
  inviteOverview: InviteOverview;
  perms: ContactPerms;
  sendingPaused: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const [navPending, startNav] = useTransition();
  const [, setParams] = useQueryStates(contactsParsers, { shallow: false, startTransition: startNav });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  const pageIds = page.items.map((c) => c.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPage = pageIds.some((id) => selected.has(id));
  const staticLists = lists.filter((l) => l.kind === "static");
  const canSelect = perms.bulk || perms.export || perms.invite || perms.delete;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (allOnPage) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function run(task: () => Promise<{ ok: true; data: unknown } | { error: string }>, success: string, clear = false) {
    startTransition(async () => {
      const result = await task();
      if ("error" in result) return setNotice({ tone: "err", text: result.error });
      setNotice({ tone: "ok", text: success });
      if (clear) setSelected(new Set());
      router.refresh();
    });
  }

  const selectedIds = [...selected];
  const selectedOnPage = page.items.filter((c) => selected.has(c.id));
  const audience: InviteAudience = (() => {
    const ineligible: Partial<Record<InviteIneligibleReason, number>> = {};
    const eligibleIds: string[] = [];
    for (const c of selectedOnPage) {
      const reason = inviteIneligibility(c);
      if (reason) ineligible[reason] = (ineligible[reason] ?? 0) + 1;
      else eligibleIds.push(c.id);
    }
    return { eligibleIds, ineligible, scope: "selection" };
  })();

  const totalPages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.total, page.page * page.pageSize);

  return (
    <div className={cn("flex flex-col gap-3", navPending && "opacity-70 transition-opacity")}>
      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Ações em massa"
          className="flex flex-wrap items-center gap-2 rounded-card bg-ink py-2 pl-4 pr-2 text-bg"
        >
          <strong className="mr-auto">
            {selected.size} {selected.size === 1 ? "selecionado" : "selecionados"}
          </strong>
          <Button size="sm" variant="ghost" className="text-bg hover:bg-ink-2" onClick={() => setSelected(new Set())}>
            Limpar
          </Button>
          {perms.bulk ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={pending}>
                    <Icon name="tag" size={16} />
                    Etiquetar
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Adicionar etiqueta</DropdownMenuLabel>
                  {tags.map((tag) => (
                    <DropdownMenuItem
                      key={tag.id}
                      onSelect={() => run(() => tagContactsAction(selectedIds, tag.id), `Etiqueta ${tag.name} adicionada.`)}
                    >
                      <TagSwatch tag={tag} />
                      {tag.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" disabled={pending}>
                    <Icon name="list" size={16} />
                    Adicionar à lista
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Listas estáticas</DropdownMenuLabel>
                  {staticLists.length === 0 ? (
                    <DropdownMenuItem disabled>Crie uma lista na aba Listas</DropdownMenuItem>
                  ) : (
                    staticLists.map((list) => (
                      <DropdownMenuItem
                        key={list.id}
                        onSelect={() => run(() => addToListAction(selectedIds, list.id), `Adicionados à lista ${list.name}.`)}
                      >
                        {list.name}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
          {perms.export ? <ExportButton size="sm" label="Exportar" request={{ contactIds: selectedIds, filter: null }} /> : null}
          {perms.invite ? (
            <Button
              size="sm"
              onClick={() => setInviteOpen(true)}
              disabled={sendingPaused}
              title={sendingPaused ? "Envio pausado: plano expirado" : undefined}
            >
              <Icon name="send" size={16} />
              Convidar sem opt-in
            </Button>
          ) : null}
          {perms.delete ? (
            <Button size="sm" className="text-err" onClick={() => setConfirmDelete(true)} disabled={pending}>
              <Icon name="trash" size={16} />
              Excluir
            </Button>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <Alert tone={notice.tone} live action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)}>Fechar</Button>}>
          {notice.text}
        </Alert>
      ) : null}

      <Table minWidth={760} aria-label="Clientes">
        <thead>
          <tr>
            {canSelect ? (
              <Th className="w-11">
                <input
                  type="checkbox"
                  className="size-[18px] shrink-0 accent-ink"
                  aria-label="Selecionar todos desta página"
                  checked={allOnPage}
                  ref={(el: HTMLInputElement | null) => {
                    if (el) el.indeterminate = someOnPage && !allOnPage;
                  }}
                  onChange={toggleAll}
                />
              </Th>
            ) : null}
            <Th>Nome</Th>
            <Th>Etiquetas</Th>
            <Th>É cliente</Th>
            <Th>Disparos</Th>
            <Th>Criado em</Th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((contact) => {
            const isSelected = selected.has(contact.id);
            return (
              <tr key={contact.id} className={cn(isSelected && "bg-warn-bg/60")}>
                {canSelect ? (
                  <Td>
                    <Checkbox aria-label={`Selecionar ${contact.name}`} checked={isSelected} onChange={() => toggle(contact.id)} />
                  </Td>
                ) : null}
                <Td>
                  <button
                    type="button"
                    onClick={() => void setParams({ ficha: contact.id })}
                    className="min-h-11 text-left hover:underline"
                    aria-label={`Abrir ficha de ${contact.name}`}
                  >
                    <strong className="flex items-center gap-1.5">
                      {contact.name}
                      {contact.channel === "instagram" ? <Chip className="ml-1">Instagram</Chip> : null}
                    </strong>
                    <span className="text-ink-2">
                      {contact.phone ? formatPhone(contact.phone) : contact.instagram ? `@${contact.instagram} · sem telefone` : "sem telefone"}
                    </span>
                  </button>
                </Td>
                <Td>
                  <TagChips tagIds={contact.tagIds} tags={tags} />
                </Td>
                <Td>{contact.isCustomer ? "Sim" : "Não"}</Td>
                <Td>
                  <ConsentChip consent={contact.consent} />
                </Td>
                <Td>{formatDate(contact.createdAt, { day: "2-digit", month: "2-digit", year: "numeric" }, timeZone)}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <nav aria-label="Paginação" className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ink-2" aria-live="polite">
          {first}–{last} de {page.total.toLocaleString("pt-BR")}
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" disabled={page.page <= 1 || navPending} onClick={() => void setParams({ pagina: page.page - 1 })} className="max-md:h-11">
            Anterior
          </Button>
          <span className="flex items-center px-2 text-[13px] text-ink-2">
            Página {page.page} de {totalPages}
          </span>
          <Button
            size="sm"
            disabled={page.page >= totalPages || navPending}
            onClick={() => void setParams({ pagina: page.page + 1 })}
            className="max-md:h-11"
          >
            Próxima
          </Button>
        </div>
      </nav>

      {!canSelect ? <p className="text-[13px] text-ink-2">Ações em massa: {NO_PERMISSION_HINT}</p> : null}

      {perms.invite ? (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          audience={audience}
          overview={inviteOverview}
          sendingPaused={sendingPaused}
          onSent={() => setSelected(new Set())}
        />
      ) : null}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          size="sm"
          title={`Excluir ${selected.size} ${selected.size === 1 ? "cliente" : "clientes"}?`}
          description="Apaga cadastro, notas e histórico. Use quando o titular pedir a exclusão dos dados (LGPD). Não dá para desfazer."
        >
          <DialogFooter>
            <Button onClick={() => setConfirmDelete(false)}>Cancelar</Button>
            <Button
              variant="primary"
              className="border-err bg-err text-surface hover:border-err hover:bg-err"
              disabled={pending}
              onClick={() => {
                setConfirmDelete(false);
                run(() => deleteContactsAction(selectedIds), "Clientes excluídos.", true);
              }}
            >
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
