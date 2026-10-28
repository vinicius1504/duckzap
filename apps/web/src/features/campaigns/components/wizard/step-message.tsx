"use client";

import { CAMPAIGN_VARIABLES, campaignMessageTypeSchema, type CampaignMessage } from "@duckzap/contracts/campaigns";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Select, Textarea } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Input, Label } from "@duckzap/ui/components/input";
import { useState } from "react";
import { messageTypeLabel } from "../../labels";
import { PhonePreview } from "../phone-preview";
import { OptionCard } from "./option-card";
import type { StepProps } from "./types";
import { channelOf } from "./validate";
import { VariationBank } from "./variation-bank";

export function StepMessage(props: StepProps) {
  const { draft, ctx } = props;
  const channel = channelOf(draft, ctx);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const isOfficial = channel?.kind === "whatsapp_official";
  const preview = isOfficial ? draft.message.body : previewText ?? undefined;

  return (
    <div className="flex flex-wrap items-start gap-8">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-5">
        {isOfficial ? <OfficialTemplatePicker {...props} /> : <BaseMessageEditor {...props} />}
        {!isOfficial ? <VariationBank {...props} onPreview={setPreviewText} /> : null}
      </div>
      <div className="flex-[0_1_300px] max-md:mx-auto md:sticky md:top-4">
        <PhonePreview message={draft.message} text={preview} senderName={ctx.companyName} />
        {previewText && !isOfficial ? (
          <Button size="sm" variant="ghost" className="mx-auto mt-2 flex" onClick={() => setPreviewText(null)}>
            Ver a mensagem base
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function OfficialTemplatePicker({ draft, update, ctx }: StepProps) {
  return (
    <>
      <Alert tone="info" title="API oficial: só modelos aprovados.">
        Neste número você envia um modelo aprovado pela Meta, sem variação por IA: o texto é exatamente o aprovado.
      </Alert>
      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 text-[13px] font-semibold">Modelo</legend>
        {ctx.metaTemplates.map((t) => {
          const approved = t.metaStatus === "approved";
          return (
            <OptionCard
              key={t.id}
              name="meta-template"
              value={t.id}
              checked={draft.message.officialTemplateId === t.id}
              disabled={!approved}
              onSelect={() =>
                update({
                  message: { ...draft.message, officialTemplateId: t.id, type: t.type, body: t.body, buttons: t.buttons, imageName: null },
                  variations: [],
                  variationsBase: null,
                })
              }
              aside={<Chip tone={approved ? "ok" : "warn"}>{approved ? "Aprovado" : "Em análise"}</Chip>}
            >
              <code className="block text-[13px] font-bold">{t.name}</code>
              <span className="text-[13px] text-ink-2">{t.body}</span>
            </OptionCard>
          );
        })}
      </fieldset>
    </>
  );
}

function BaseMessageEditor({ draft, update }: StepProps) {
  const m = draft.message;
  const setMessage = (patch: Partial<CampaignMessage>) => update({ message: { ...m, ...patch } });

  function insert(variable: string) {
    const el = document.getElementById("cmp-body");
    if (!(el instanceof HTMLTextAreaElement)) return setMessage({ body: m.body + variable });
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const body = `${m.body.slice(0, start)}${variable}${m.body.slice(end)}`;
    setMessage({ body });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + variable.length, start + variable.length);
    });
  }

  return (
    <>
      <div className="max-w-sm">
        <Label htmlFor="cmp-type">Tipo de mensagem</Label>
        <Select
          id="cmp-type"
          value={m.type}
          onChange={(e) => {
            const parsed = campaignMessageTypeSchema.safeParse(e.target.value);
            if (parsed.success) setMessage({ type: parsed.data });
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
        <Label htmlFor="cmp-body">Mensagem base</Label>
        <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Inserir variável">
          <span className="text-[13px] text-ink-2">Inserir:</span>
          {CAMPAIGN_VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insert(v)}
              className="h-8 rounded-full bg-surface-2 px-3 text-xs font-semibold text-ink-2 hover:bg-surface-hover max-md:h-11"
            >
              {v}
            </button>
          ))}
        </div>
        <Textarea
          id="cmp-body"
          rows={5}
          maxLength={1024}
          value={m.body}
          aria-describedby="cmp-body-help"
          onChange={(e) => setMessage({ body: e.target.value })}
        />
        <p id="cmp-body-help" className="mt-1 flex flex-wrap justify-between gap-2 text-xs text-ink-2">
          <span>A IA cria variações a partir desta mensagem, mantendo variáveis, links, preços e datas.</span>
          <span>{m.body.length}/1024</span>
        </p>
        {m.body.trim() && !m.body.includes("{nome}") ? (
          <p className="mt-1 text-xs font-semibold text-warn">Dica: use {"{nome}"} para a mensagem parecer menos automática.</p>
        ) : null}
      </div>

      <div className="flex items-start gap-2.5 rounded-control bg-surface-2 p-3 text-[13px]">
        <Icon name="shield" size={18} className="mt-0.5 shrink-0" />
        <p>
          <strong>Linha de saída (obrigatória, vai no fim de toda mensagem):</strong>
          <br />
          {m.optOutLine}
        </p>
      </div>

      {m.type === "text_image" ? (
        <div>
          <span className="mb-1.5 block text-[13px] font-semibold">Imagem</span>
          <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-control border-2 border-dashed border-field p-4 text-center text-[13px] text-ink-2 hover:bg-surface-hover">
            <Icon name="image" size={22} />
            {m.imageName ? (
              <span>
                <strong className="text-ink">{m.imageName}</strong> · trocar imagem
              </span>
            ) : (
              <span>
                Arraste uma imagem aqui ou <strong className="text-ink">escolha um arquivo</strong>
              </span>
            )}
            <input
              type="file"
              accept="image/jpeg,image/png"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setMessage({ imageName: file.name });
              }}
            />
          </label>
          <p className="mt-1 text-xs text-ink-2">JPG ou PNG, até 5 MB. A mesma imagem vai para todos.</p>
        </div>
      ) : null}

      {m.type === "buttons" ? (
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">Botões de resposta (até 3)</legend>
          <div className="flex flex-col gap-2">
            {m.buttons.map((b, i) => (
              <div key={i} className="flex gap-2">
                <label htmlFor={`cmp-btn-${i}`} className="sr-only">
                  Botão {i + 1}
                </label>
                <Input
                  id={`cmp-btn-${i}`}
                  value={b}
                  maxLength={20}
                  onChange={(e) => setMessage({ buttons: m.buttons.map((x, j) => (j === i ? e.target.value : x)) })}
                />
                <Button size="icon" variant="ghost" aria-label={`Remover botão ${i + 1}`} onClick={() => setMessage({ buttons: m.buttons.filter((_, j) => j !== i) })}>
                  <Icon name="trash" size={16} />
                </Button>
              </div>
            ))}
            {m.buttons.length < 3 ? (
              <Button size="sm" className="self-start" onClick={() => setMessage({ buttons: [...m.buttons, ""] })}>
                <Icon name="plus" size={16} /> Adicionar botão
              </Button>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {m.type === "list" ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1.5 text-[13px] font-semibold">Menu de lista</legend>
          <div className="max-w-xs">
            <Label htmlFor="cmp-list-label">Texto do botão que abre o menu</Label>
            <Input id="cmp-list-label" value={m.listButtonLabel} maxLength={20} onChange={(e) => setMessage({ listButtonLabel: e.target.value })} />
          </div>
          {m.listItems.map((item, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-control border border-line p-2.5">
              <div className="flex-[1_1_140px]">
                <Label htmlFor={`cmp-item-${i}`}>Opção {i + 1}</Label>
                <Input
                  id={`cmp-item-${i}`}
                  value={item.title}
                  maxLength={24}
                  onChange={(e) => setMessage({ listItems: m.listItems.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                />
              </div>
              <div className="flex-[2_1_180px]">
                <Label htmlFor={`cmp-item-desc-${i}`}>Descrição (opcional)</Label>
                <Input
                  id={`cmp-item-desc-${i}`}
                  value={item.description}
                  maxLength={72}
                  onChange={(e) => setMessage({ listItems: m.listItems.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                />
              </div>
              <Button size="icon" variant="ghost" aria-label={`Remover opção ${i + 1}`} onClick={() => setMessage({ listItems: m.listItems.filter((_, j) => j !== i) })}>
                <Icon name="trash" size={16} />
              </Button>
            </div>
          ))}
          {m.listItems.length < 10 ? (
            <Button size="sm" className="self-start" onClick={() => setMessage({ listItems: [...m.listItems, { title: "", description: "" }] })}>
              <Icon name="plus" size={16} /> Adicionar opção
            </Button>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}
