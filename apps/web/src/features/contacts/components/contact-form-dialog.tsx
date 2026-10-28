"use client";

import { contactOriginSchema, type Contact, type ContactInput, type ContactOrigin, type Tag } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox, Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { useQueryStates } from "nuqs";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { saveContactAction } from "../actions";
import { originLabel } from "../labels";
import { contactsParsers } from "../search-params";
import { TagSwatch } from "./badges";

type Owner = { id: string; name: string };

function fromContact(c: Contact | null): ContactInput {
  return {
    name: c?.name ?? "",
    phone: c?.phone ? c.phone.replace(/^\+55/, "") : "",
    email: c?.email ?? "",
    instagram: c?.instagram ?? "",
    isCustomer: c?.isCustomer ?? false,
    tagIds: c?.tagIds ?? [],
    origin: c?.origin ?? "service",
    originNote: c?.originNote ?? "",
    ownerId: c?.ownerId ?? null,
    birthDate: c?.birthDate ?? "",
  };
}

/** Novo cliente / editar cliente. */
export function ContactFormDialog({
  open,
  onOpenChange,
  contact,
  tags,
  owners,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact | null;
  tags: Tag[];
  owners: Owner[];
}) {
  const router = useRouter();
  const [, setParams] = useQueryStates(contactsParsers, { shallow: false });
  const [form, setForm] = useState<ContactInput>(() => fromContact(contact));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setForm(fromContact(contact));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function set<K extends keyof ContactInput>(key: K, value: ContactInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await saveContactAction(contact?.id ?? null, form);
      if ("error" in result) return setError(result.error);
      onOpenChange(false);
      if (!contact) void setParams({ ficha: result.data.id });
      else router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={contact ? `Editar ${contact.name}` : "Novo cliente"}>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div>
            <Label htmlFor="ct-nome">Nome</Label>
            <Input id="ct-nome" value={form.name} onChange={(e) => set("name", e.target.value)} required autoComplete="off" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ct-tel">Telefone (WhatsApp)</Label>
              <Input id="ct-tel" type="tel" inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="67 99812-3456" />
            </div>
            <div>
              <Label htmlFor="ct-email">E-mail</Label>
              <Input id="ct-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ct-ig">Instagram</Label>
              <Input id="ct-ig" value={form.instagram} onChange={(e) => set("instagram", e.target.value)} placeholder="@usuario" />
            </div>
            <div>
              <Label htmlFor="ct-nasc">Nascimento</Label>
              <Input id="ct-nasc" type="date" value={form.birthDate} onChange={(e) => set("birthDate", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ct-origem">Origem do contato</Label>
              <Select
                id="ct-origem"
                value={form.origin}
                onChange={(e) => {
                  const parsed = contactOriginSchema.safeParse(e.target.value);
                  if (parsed.success) set("origin", parsed.data satisfies ContactOrigin);
                }}
              >
                {contactOriginSchema.options.map((o) => (
                  <option key={o} value={o}>
                    {originLabel[o]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="ct-resp">Responsável</Label>
              <Select id="ct-resp" value={form.ownerId ?? ""} onChange={(e) => set("ownerId", e.target.value || null)}>
                <option value="">Ninguém</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="ct-origem-det">Detalhe da origem (opcional)</Label>
            <Input id="ct-origem-det" value={form.originNote} onChange={(e) => set("originNote", e.target.value)} placeholder="Ex.: indicação da Carla" />
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5">
            <Checkbox checked={form.isCustomer} onChange={(e) => set("isCustomer", e.target.checked)} />
            Já é cliente (já fez algum atendimento)
          </label>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Etiquetas</legend>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <label key={tag.id} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-line px-3">
                  <Checkbox
                    checked={form.tagIds.includes(tag.id)}
                    onChange={(e) => set("tagIds", e.target.checked ? [...form.tagIds, tag.id] : form.tagIds.filter((id) => id !== tag.id))}
                  />
                  <TagSwatch tag={tag} />
                  {tag.name}
                </label>
              ))}
            </div>
          </fieldset>
          {error ? (
            <Alert tone="err" live>
              {error}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Salvando…" : contact ? "Salvar" : "Criar cliente"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
