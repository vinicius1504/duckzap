"use client";

import { campaignMessageTypeSchema, type CampaignMessageType, type CampaignTemplate } from "@duckzap/contracts/campaigns";
import { Button, buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip, type ChipTone } from "@duckzap/ui/components/chip";
import { ConfirmDialog } from "@duckzap/ui/components/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@duckzap/ui/components/dialog";
import { Alert, EmptyState, Spinner } from "@duckzap/ui/components/feedback";
import { Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import Link from "next/link";
import { useState, useTransition } from "react";
import { deleteCampaignTemplateAction, saveCampaignTemplateAction } from "../actions";
import { messageTypeLabel } from "../labels";

const metaStatus: Record<NonNullable<CampaignTemplate["metaStatus"]>, { label: string; tone: ChipTone }> = {
  approved: { label: "Aprovado pela Meta", tone: "ok" },
  pending: { label: "Em análise", tone: "warn" },
  rejected: { label: "Rejeitado", tone: "err" },
};

export function TemplatesPanel({ templates }: { templates: CampaignTemplate[] }) {
  const internal = templates.filter((t) => t.source === "internal");
  const meta = templates.filter((t) => t.source === "meta");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">Mensagens prontas para começar uma campanha mais rápido.</p>
        <NewTemplateDialog />
      </div>
      {internal.length ? (
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr))]">
          {internal.map((t) => (
            <li key={t.id}>
              <Card padding="sm" className="flex h-full flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <strong>{t.name}</strong>
                  <Chip>{messageTypeLabel[t.type]}</Chip>
                </div>
                <p className="line-clamp-3 flex-1 text-[13px] text-ink-2">{t.body}</p>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/campanhas/nova?modelo=${t.id}`} className={buttonVariants({ size: "sm", variant: "primary" })}>
                    Usar modelo
                  </Link>
                  <ConfirmDialog
                    danger
                    trigger={
                      <Button size="sm" variant="danger-ghost" aria-label={`Excluir modelo ${t.name}`}>
                        <Icon name="trash" size={16} />
                      </Button>
                    }
                    title="Excluir este modelo?"
                    description={`“${t.name}” deixa de aparecer nos modelos. As campanhas que já usaram esse texto não mudam.`}
                    confirmLabel="Excluir"
                    pendingLabel="Excluindo…"
                    onConfirm={async () => {
                      const result = await deleteCampaignTemplateAction(t.id);
                      return result.error !== undefined ? { error: result.error } : { ok: true };
                    }}
                  />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <Card>
          <EmptyState icon="note" title="Nenhum modelo ainda" description="Salve uma mensagem que você usa sempre e reaproveite nas próximas campanhas." />
        </Card>
      )}

      <section aria-labelledby="meta-templates" className="flex flex-col gap-3">
        <div>
          <h2 id="meta-templates" className="font-bold">
            Modelos da API oficial
          </h2>
          <p className="text-[13px] text-ink-2">
            No número da API oficial só dá para enviar modelos aprovados pela Meta. Eles são criados e aprovados no WhatsApp Manager.
          </p>
        </div>
        <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr))]">
          {meta.map((t) => (
            <li key={t.id}>
              <Card padding="sm" className="flex h-full flex-col gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <code className="text-[13px] font-bold">{t.name}</code>
                  {t.metaStatus ? <Chip tone={metaStatus[t.metaStatus].tone}>{metaStatus[t.metaStatus].label}</Chip> : null}
                </div>
                <p className="line-clamp-3 text-[13px] text-ink-2">{t.body}</p>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NewTemplateDialog() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CampaignMessageType>("text");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(form: FormData) {
    setError(null);
    const buttons = String(form.get("buttons") ?? "")
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
    startTransition(async () => {
      const result = await saveCampaignTemplateAction({
        name: String(form.get("name") ?? ""),
        type,
        body: String(form.get("body") ?? ""),
        buttons: type === "buttons" ? buttons : [],
      });
      if (result.error !== undefined) setError(result.error);
      else setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <Icon name="plus" size={16} /> Novo modelo
        </Button>
      </DialogTrigger>
      <DialogContent title="Novo modelo" description="Use {nome} e {empresa} para personalizar.">
        <form action={submit} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="tpl-name">Nome do modelo</Label>
            <Input id="tpl-name" name="name" required maxLength={60} />
          </div>
          <div>
            <Label htmlFor="tpl-type">Tipo de mensagem</Label>
            <Select
              id="tpl-type"
              value={type}
              onChange={(e) => {
                const parsed = campaignMessageTypeSchema.safeParse(e.target.value);
                if (parsed.success) setType(parsed.data);
              }}
            >
              {campaignMessageTypeSchema.options.map((t) => (
                <option key={t} value={t}>
                  {messageTypeLabel[t]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tpl-body">Mensagem</Label>
            <Textarea id="tpl-body" name="body" rows={4} required maxLength={1024} />
          </div>
          {type === "buttons" ? (
            <div>
              <Label htmlFor="tpl-buttons">Botões (um por linha, até 3)</Label>
              <Textarea id="tpl-buttons" name="buttons" rows={3} />
            </div>
          ) : null}
          {error ? <Alert tone="err" live>{error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button>Cancelar</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? <Spinner size={16} /> : null} Salvar modelo
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
