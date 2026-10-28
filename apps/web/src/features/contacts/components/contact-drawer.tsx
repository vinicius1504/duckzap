"use client";

import type { ContactDetail, InviteOverview, Tag } from "@duckzap/contracts/contacts";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Dialog, DialogContent } from "@duckzap/ui/components/dialog";
import { Icon } from "@duckzap/ui/components/icon";
import Link from "next/link";
import { useQueryStates } from "nuqs";
import { useState } from "react";
import type { ContactPerms } from "../perms";
import { contactsParsers } from "../search-params";
import { ContactProfile, type ProfileAppointment } from "./contact-profile";

/** Ficha em gaveta à direita, aberta por ?ficha=<id>. */
export function ContactDrawer(props: {
  contact: ContactDetail;
  tags: Tag[];
  owners: { id: string; name: string }[];
  appointments: ProfileAppointment[];
  inviteOverview: InviteOverview;
  perms: ContactPerms;
  sendingPaused: boolean;
  timeZone: string;
}) {
  const [, setParams] = useQueryStates(contactsParsers, { shallow: false });
  // fecha na hora; a URL (sem ?ficha) recarrega a página por trás
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setOpen(false);
        void setParams({ ficha: null });
      }}
    >
      <DialogContent side="right" title={props.contact.name} className="w-[min(520px,100%)]">
        <ContactProfile {...props} variant="drawer" />
        <Link href={`/clientes/${props.contact.id}`} className={buttonVariants({ variant: "ghost", className: "self-start" })}>
          Abrir ficha completa
          <Icon name="arrowRight" size={16} />
        </Link>
      </DialogContent>
    </Dialog>
  );
}
