"use client";

import type { ContactFilter, ContactList, Tag } from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Chip } from "@duckzap/ui/components/chip";
import { FilterSelect } from "@duckzap/ui/components/filter-select";
import { Icon } from "@duckzap/ui/components/icon";
import { Spinner } from "@duckzap/ui/components/feedback";
import { useQueryStates } from "nuqs";
import { useEffect, useState, useTransition } from "react";
import { consentView } from "../labels";
import { consentParam, consentParamKeys, contactsParsers, createdParams, inactiveParams, type ConsentParam } from "../search-params";
import { ListFormDialog } from "./list-form-dialog";

const consentOptions: { value: ConsentParam; label: string }[] = consentParamKeys.map((key) => ({
  value: key,
  label: consentView[consentParam[key]].short,
}));

const createdLabel: Record<(typeof createdParams)[number], string> = { "7d": "Últimos 7 dias", "30d": "Últimos 30 dias", "90d": "Últimos 90 dias" };
const inactiveLabel: Record<(typeof inactiveParams)[number], string> = { "30d": "Há 30 dias", "90d": "Há 90 dias", "180d": "Há 180 dias" };

function isCreated(v: string): v is (typeof createdParams)[number] {
  return (createdParams as readonly string[]).includes(v);
}
function isInactive(v: string): v is (typeof inactiveParams)[number] {
  return (inactiveParams as readonly string[]).includes(v);
}
function isConsent(v: string): v is ConsentParam {
  return (consentParamKeys as readonly string[]).includes(v);
}

/** Busca e filtros, tudo na URL (?q=&etiqueta=&cliente=&disparos=&criado=&inativo=). */
export function ContactsToolbar({
  tags,
  activeList,
  currentFilter,
}: {
  tags: Tag[];
  activeList: ContactList | null;
  currentFilter: ContactFilter;
}) {
  const [pending, startTransition] = useTransition();
  const [params, setParams] = useQueryStates(contactsParsers, { shallow: false, startTransition });
  const [search, setSearch] = useState(params.q);
  const [segmentOpen, setSegmentOpen] = useState(false);

  // busca com atraso curto para não recarregar a cada tecla
  useEffect(() => {
    if (search === params.q) return;
    const id = setTimeout(() => void setParams({ q: search.trim() || null, pagina: null }), 350);
    return () => clearTimeout(id);
  }, [search, params.q, setParams]);

  const filtersOn = Boolean(params.etiqueta || params.cliente || params.disparos || params.criado || params.inativo || params.q);

  function clear() {
    setSearch("");
    void setParams({ q: null, etiqueta: null, cliente: null, disparos: null, criado: null, inativo: null, pagina: null });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-[1_1_260px]">
          <label htmlFor="busca-cliente" className="sr-only">
            Buscar cliente
          </label>
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
          <input
            id="busca-cliente"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, telefone ou e-mail"
            className="h-10 w-full rounded-control border border-field bg-surface pl-10 pr-10 text-ink placeholder:text-ink-2"
          />
          {pending ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-2" role="status" aria-label="Carregando">
              <Spinner size={16} />
            </span>
          ) : null}
        </div>

        <ToolbarFilter
          id="f-etiqueta"
          label="Etiqueta"
          value={params.etiqueta ?? ""}
          onChange={(v) => void setParams({ etiqueta: v || null, pagina: null })}
          options={tags.map((t) => ({ value: t.id, label: t.name }))}
        />
        <ToolbarFilter
          id="f-cliente"
          label="É cliente"
          value={params.cliente ?? ""}
          onChange={(v) => void setParams({ cliente: v === "sim" || v === "nao" ? v : null, pagina: null })}
          options={[
            { value: "sim", label: "Sim" },
            { value: "nao", label: "Não" },
          ]}
        />
        <ToolbarFilter
          id="f-disparos"
          label="Disparos"
          value={params.disparos ?? ""}
          onChange={(v) => void setParams({ disparos: isConsent(v) ? v : null, pagina: null })}
          options={consentOptions}
        />
        <ToolbarFilter
          id="f-criado"
          label="Criado em"
          value={params.criado ?? ""}
          onChange={(v) => void setParams({ criado: isCreated(v) ? v : null, pagina: null })}
          options={createdParams.map((v) => ({ value: v, label: createdLabel[v] }))}
        />
        <ToolbarFilter
          id="f-inativo"
          label="Sem conversa"
          value={params.inativo ?? ""}
          onChange={(v) => void setParams({ inativo: isInactive(v) ? v : null, pagina: null })}
          options={inactiveParams.map((v) => ({ value: v, label: inactiveLabel[v] }))}
        />
      </div>

      {filtersOn || activeList ? (
        <div className="flex flex-wrap items-center gap-2">
          {activeList ? (
            <Chip tone="info" className="h-8 pr-1">
              {activeList.kind === "segment" ? "Segmento" : "Lista"}: {activeList.name}
              <button
                type="button"
                aria-label={`Sair da lista ${activeList.name}`}
                onClick={() => void setParams({ lista: null, pagina: null })}
                className="flex size-6 items-center justify-center rounded-full hover:bg-surface"
              >
                <Icon name="close" size={14} strokeWidth={2.2} />
              </button>
            </Chip>
          ) : null}
          {filtersOn ? (
            <>
              <Button size="sm" variant="ghost" onClick={clear}>
                Limpar filtros
              </Button>
              <Button size="sm" onClick={() => setSegmentOpen(true)}>
                <Icon name="filter" size={16} />
                Salvar como segmento
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <ListFormDialog
        open={segmentOpen}
        onOpenChange={setSegmentOpen}
        tags={tags}
        initialKind="segment"
        initialFilter={currentFilter}
      />
    </div>
  );
}

/** Filtro da barra no padrão do sistema (`FilterSelect` do ui); aqui só junta as opções "Todos" + as da tela. */
function ToolbarFilter({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <FilterSelect id={id} label={label} value={value} onChange={(e) => onChange(e.target.value)} className="flex-[0_1_220px] max-sm:flex-[1_1_100%]">
      <option value="">Todos</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </FilterSelect>
  );
}
