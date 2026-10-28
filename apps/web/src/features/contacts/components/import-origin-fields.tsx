"use client";

import {
  RELATIONSHIP_CONFIRMATION,
  importOriginSchema,
  type ContactList,
  type ImportOrigin,
  type Tag,
} from "@duckzap/contracts/contacts";
import { Checkbox, Select } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { originLabel } from "../labels";
import { TagSwatch } from "./badges";

/** Passo "Origem" das importações (planilha e WhatsApp): de onde vieram, etiquetas, lista e confirmação de relação. */
export type OriginFields = {
  origin: ImportOrigin | "";
  originNote: string;
  tagIds: string[];
  listId: string;
  confirmed: boolean;
};

export const emptyOriginFields: OriginFields = { origin: "", originNote: "", tagIds: [], listId: "", confirmed: false };

export function ImportOriginFields({
  idPrefix,
  tags,
  lists,
  value,
  onChange,
  showError,
}: {
  /** Prefixo dos ids dos campos (evita repetir id se dois fluxos existirem na página). */
  idPrefix: string;
  tags: Tag[];
  lists: ContactList[];
  value: OriginFields;
  onChange: (patch: Partial<OriginFields>) => void;
  /** Há erro na tela: destaca a origem se ainda estiver vazia. */
  showError: boolean;
}) {
  const staticLists = lists.filter((l) => l.kind === "static");
  return (
    <>
      <div>
        <Label htmlFor={`${idPrefix}-origem`}>
          De onde vieram estes contatos? <span className="text-err">*</span>
        </Label>
        <Select
          id={`${idPrefix}-origem`}
          required
          value={value.origin}
          invalid={showError && !value.origin}
          onChange={(e) => {
            const parsed = importOriginSchema.safeParse(e.target.value);
            onChange({ origin: parsed.success ? parsed.data : "" });
          }}
        >
          <option value="">Escolha a origem</option>
          {importOriginSchema.options.map((o) => (
            <option key={o} value={o}>
              {originLabel[o]}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-[13px] text-ink-2">Obrigatório. Sem origem, ninguém recebe o convite de consentimento.</p>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-origem-det`}>Detalhe (opcional)</Label>
        <Input
          id={`${idPrefix}-origem-det`}
          value={value.originNote}
          onChange={(e) => onChange({ originNote: e.target.value })}
          placeholder="Ex.: fichas de papel da recepção, 2025"
          maxLength={160}
        />
      </div>
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-semibold">Etiquetas para todos (opcional)</legend>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <label key={tag.id} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-line px-3">
              <Checkbox
                checked={value.tagIds.includes(tag.id)}
                onChange={(e) => onChange({ tagIds: e.target.checked ? [...value.tagIds, tag.id] : value.tagIds.filter((id) => id !== tag.id) })}
              />
              <TagSwatch tag={tag} />
              {tag.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Label htmlFor={`${idPrefix}-lista`}>Adicionar a uma lista (opcional)</Label>
        <Select id={`${idPrefix}-lista`} value={value.listId} onChange={(e) => onChange({ listId: e.target.value })}>
          <option value="">Nenhuma</option>
          {staticLists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </div>
      <label className="flex cursor-pointer gap-3 rounded-control border border-field p-3">
        <Checkbox
          checked={value.confirmed}
          onChange={(e) => onChange({ confirmed: e.target.checked })}
          className="mt-0.5"
          aria-describedby={`${idPrefix}-conf-hint`}
        />
        <span>
          <strong>{RELATIONSHIP_CONFIRMATION}.</strong>
          <span id={`${idPrefix}-conf-hint`} className="mt-0.5 block text-[13px] text-ink-2">
            Obrigatório. Os contatos entram sem opt-in: só recebem campanhas depois de aceitar o convite.
          </span>
        </span>
      </label>
    </>
  );
}
