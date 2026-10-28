"use client";

import type { ContactList, ContactListQuery, InviteOverview, Tag } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@duckzap/ui/components/dropdown-menu";
import { Icon } from "@duckzap/ui/components/icon";
import { Tabs, TabsList, TabsTrigger } from "@duckzap/ui/components/tabs";
import { useQueryStates } from "nuqs";
import { useState, useTransition, type ReactNode } from "react";
import type { WhatsappImportChannel } from "../api";
import { NO_PERMISSION_HINT, type ContactPerms } from "../perms";
import { contactsParsers, tabs, type ContactsTab } from "../search-params";
import { ContactFormDialog } from "./contact-form-dialog";
import { ExportButton } from "./export-button";
import { ImportDialog } from "./import-dialog";
import { InviteDialog } from "./invite-dialog";
import { WhatsappImportDialog } from "./whatsapp-import-dialog";

/** Importar, exportar, convidar sem opt-in e novo cliente (topo da página). */
export function ContactsHeaderActions({
  tags,
  lists,
  owners,
  inviteOverview,
  whatsappChannels,
  exportQuery,
  perms,
  sendingPaused,
}: {
  tags: Tag[];
  lists: ContactList[];
  owners: { id: string; name: string }[];
  inviteOverview: InviteOverview;
  /** Números WhatsApp por QR code para "Importar › Do WhatsApp"; `null` se Canais não respondeu. */
  whatsappChannels: WhatsappImportChannel[] | null;
  exportQuery: Omit<ContactListQuery, "page" | "pageSize">;
  perms: ContactPerms;
  sendingPaused: boolean;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  return (
    <>
      {perms.import ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button>
              <Icon name="upload" size={16} />
              Importar
              <Icon name="chevronDown" size={14} strokeWidth={2.4} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setWhatsappOpen(true)}>
              <Icon name="phone" size={18} />
              Do WhatsApp
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setImportOpen(true)}>
              <Icon name="upload" size={18} />
              De planilha
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {perms.export ? <ExportButton request={{ contactIds: null, filter: exportQuery }} /> : null}
      {perms.invite ? (
        <Button
          onClick={() => setInviteOpen(true)}
          disabled={sendingPaused}
          title={sendingPaused ? "Envio pausado: o plano expirou" : undefined}
        >
          <Icon name="send" size={16} />
          Convidar sem opt-in
        </Button>
      ) : null}
      <Button variant="primary" onClick={() => setNewOpen(true)} disabled={!perms.edit} title={perms.edit ? undefined : NO_PERMISSION_HINT}>
        <Icon name="plus" size={16} />
        Novo cliente
      </Button>

      {perms.import ? <ImportDialog open={importOpen} onOpenChange={setImportOpen} tags={tags} lists={lists} /> : null}
      {perms.import ? (
        <WhatsappImportDialog open={whatsappOpen} onOpenChange={setWhatsappOpen} tags={tags} lists={lists} channels={whatsappChannels} />
      ) : null}
      {perms.invite ? (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          overview={inviteOverview}
          sendingPaused={sendingPaused}
          audience={{ eligibleIds: inviteOverview.eligibleContactIds, ineligible: inviteOverview.ineligibleCounts, scope: "all" }}
        />
      ) : null}
      <ContactFormDialog open={newOpen} onOpenChange={setNewOpen} contact={null} tags={tags} owners={owners} />
    </>
  );
}

const tabLabels: Record<ContactsTab, string> = { todos: "Todos", listas: "Listas", etiquetas: "Etiquetas" };

/** Abas Todos / Listas / Etiquetas na URL (?aba=). O conteúdo da aba ativa vem do server. */
export function ContactsTabs({ tab, children }: { tab: ContactsTab; children: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [, setParams] = useQueryStates(contactsParsers, { shallow: false, startTransition });
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        const next = tabs.find((t) => t === value);
        if (next) void setParams({ aba: next === "todos" ? null : next, pagina: null, ficha: null });
      }}
      className={pending ? "opacity-70 transition-opacity" : undefined}
    >
      <TabsList aria-label="Seções de Clientes">
        {tabs.map((t) => (
          <TabsTrigger key={t} value={t}>
            {tabLabels[t]}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="pt-[18px]">{children}</div>
    </Tabs>
  );
}
