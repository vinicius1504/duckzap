"use client";

import type { Tag } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Icon } from "@duckzap/ui/components/icon";
import { useState } from "react";
import { NO_PERMISSION_HINT, type ContactPerms } from "../perms";
import { ContactFormDialog } from "./contact-form-dialog";

/** "Novo cliente" para o estado vazio da lista: mesmo botão e mesmo diálogo do cabeçalho da página. */
export function NewContactButton({ tags, owners, perms }: { tags: Tag[]; owners: { id: string; name: string }[]; perms: ContactPerms }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={!perms.edit} title={perms.edit ? undefined : NO_PERMISSION_HINT}>
        <Icon name="plus" size={16} />
        Novo cliente
      </Button>
      <ContactFormDialog open={open} onOpenChange={setOpen} contact={null} tags={tags} owners={owners} />
    </>
  );
}
