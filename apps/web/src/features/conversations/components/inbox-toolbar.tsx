"use client";

import type { ConversationPriority, InboxLookups } from "@duckzap/contracts/conversations";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger, DialogClose } from "@duckzap/ui/components/dialog";
import { FilterSelect } from "@duckzap/ui/components/filter-select";
import { Select } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Segmented } from "@duckzap/ui/components/segmented";
import { cn } from "@duckzap/ui/cn";
import { useQueryStates } from "nuqs";
import type { ReactNode } from "react";
import { inboxParsers, inboxUrlKeys, type ViewSlug } from "../search-params";
import { PRIORITY_LABEL } from "./view-model";

const views = [
  { value: "lista", label: "Lista" },
  { value: "quadro", label: "Quadro" },
] as const satisfies readonly { value: ViewSlug; label: string }[];

const priorities = Object.keys(PRIORITY_LABEL) as ConversationPriority[];

function useInboxState() {
  return useQueryStates(inboxParsers, { urlKeys: inboxUrlKeys, shallow: false });
}

/** Título, Lista/Quadro e filtros (canal, equipe, etiqueta, prioridade). Tudo na URL. */
export function InboxToolbar({ lookups, className }: { lookups: InboxLookups; className?: string }) {
  const [state, setState] = useInboxState();
  const activeFilters = [state.channel, state.team, state.tag, state.priority].filter(Boolean).length;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 border-b border-line bg-surface px-6 py-3.5 max-md:px-4 max-md:py-2.5",
        className,
      )}
    >
      <h1 className="mr-2 text-xl font-extrabold tracking-[-0.01em]">Conversas</h1>
      <Segmented
        label="Visualização"
        options={views}
        value={state.view}
        onChange={(view) => setState({ view, conversation: view === "quadro" ? null : state.conversation })}
      />
      <div className="ml-auto flex flex-wrap gap-2 max-lg:hidden">
        <Filters lookups={lookups} />
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <Button size="sm" className="ml-auto h-10 lg:hidden" aria-label={activeFilters ? `Filtros, ${activeFilters} ativos` : "Filtros"}>
            <Icon name="filter" size={16} />
            Filtros
            {activeFilters ? (
              <span className="flex size-5 items-center justify-center rounded-full bg-duck text-[11px] font-extrabold text-on-duck">
                {activeFilters}
              </span>
            ) : null}
          </Button>
        </DialogTrigger>
        <DialogContent title="Filtrar conversas" size="sm">
          <div className="flex flex-col gap-3">
            <Filters lookups={lookups} stacked />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setState({ channel: null, team: null, tag: null, priority: null })}
              disabled={!activeFilters}
            >
              Limpar filtros
            </Button>
            <DialogClose asChild>
              <Button variant="primary">Ver conversas</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Barra: filtro padrão (nome dentro do campo). Gaveta: nome acima do campo, como nos formulários. */
function Field({
  name,
  id,
  value,
  onChange,
  stacked,
  suffix,
  children,
}: {
  name: string;
  id: string;
  value: string;
  onChange: (value: string) => void;
  stacked: boolean;
  suffix: string;
  children: ReactNode;
}) {
  const fieldId = `f-${id}${suffix}`;
  if (!stacked) {
    return (
      <FilterSelect id={fieldId} label={name} value={value} onChange={(e) => onChange(e.target.value)} className="h-9 max-w-52">
        {children}
      </FilterSelect>
    );
  }
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-[13px] font-semibold">
        {name}
      </label>
      <Select id={fieldId} className="h-11" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </Select>
    </div>
  );
}

function Filters({ lookups, stacked = false }: { lookups: InboxLookups; stacked?: boolean }) {
  const [state, setState] = useInboxState();
  const field = { stacked, suffix: stacked ? "-m" : "" };

  return (
    <>
      <Field {...field} name="Canal" id="canal" value={state.channel ?? ""} onChange={(value) => setState({ channel: value || null })}>
        <option value="">Todos</option>
        {lookups.channels.map((ch) => (
          <option key={ch.id} value={ch.id}>
            {ch.name}
            {ch.status === "disconnected" ? " (desconectado)" : ""}
          </option>
        ))}
      </Field>
      <Field {...field} name="Equipe" id="equipe" value={state.team ?? ""} onChange={(value) => setState({ team: value || null })}>
        <option value="">Todas</option>
        {lookups.teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Field>
      <Field {...field} name="Etiqueta" id="etiqueta" value={state.tag ?? ""} onChange={(value) => setState({ tag: value || null })}>
        <option value="">Todas</option>
        <optgroup label="Etapas do funil">
          {lookups.tags
            .filter((t) => t.funnelStage !== null)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </optgroup>
        <optgroup label="Outras etiquetas">
          {lookups.tags
            .filter((t) => t.funnelStage === null)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </optgroup>
      </Field>
      <Field
        {...field}
        name="Prioridade"
        id="prioridade"
        value={state.priority ?? ""}
        onChange={(value) => setState({ priority: priorities.find((p) => p === value) ?? null })}
      >
        <option value="">Todas</option>
        {priorities.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p].label}
          </option>
        ))}
      </Field>
    </>
  );
}
