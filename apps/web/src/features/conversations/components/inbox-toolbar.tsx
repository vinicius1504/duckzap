"use client";

import type { ConversationPriority, InboxLookups } from "@duckzap/contracts/conversations";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogTrigger, DialogClose } from "@duckzap/ui/components/dialog";
import { Select } from "@duckzap/ui/components/form-controls";
import { Icon } from "@duckzap/ui/components/icon";
import { Segmented } from "@duckzap/ui/components/segmented";
import { cn } from "@duckzap/ui/cn";
import { useQueryStates } from "nuqs";
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

function Filters({ lookups, stacked = false }: { lookups: InboxLookups; stacked?: boolean }) {
  const [state, setState] = useInboxState();
  const size = stacked ? "h-11" : "h-8 w-auto rounded-lg text-[13px] font-semibold";
  const labelClass = stacked ? "mb-1.5 block text-[13px] font-semibold" : "sr-only";
  const prefix = (text: string) => (stacked ? "" : `${text}: `);

  return (
    <>
      <div>
        <label htmlFor={`f-canal${stacked ? "-m" : ""}`} className={labelClass}>
          Canal
        </label>
        <Select
          id={`f-canal${stacked ? "-m" : ""}`}
          className={size}
          value={state.channel ?? ""}
          onChange={(e) => setState({ channel: e.target.value || null })}
        >
          <option value="">{prefix("Canal")}Todos</option>
          {lookups.channels.map((ch) => (
            <option key={ch.id} value={ch.id}>
              {prefix("Canal")}
              {ch.name}
              {ch.status === "disconnected" ? " (desconectado)" : ""}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label htmlFor={`f-equipe${stacked ? "-m" : ""}`} className={labelClass}>
          Equipe
        </label>
        <Select
          id={`f-equipe${stacked ? "-m" : ""}`}
          className={size}
          value={state.team ?? ""}
          onChange={(e) => setState({ team: e.target.value || null })}
        >
          <option value="">{prefix("Equipe")}Todas</option>
          {lookups.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {prefix("Equipe")}
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label htmlFor={`f-etiqueta${stacked ? "-m" : ""}`} className={labelClass}>
          Etiqueta
        </label>
        <Select
          id={`f-etiqueta${stacked ? "-m" : ""}`}
          className={size}
          value={state.tag ?? ""}
          onChange={(e) => setState({ tag: e.target.value || null })}
        >
          <option value="">{stacked ? "Todas" : "Etiqueta"}</option>
          <optgroup label="Etapas do funil">
            {lookups.tags
              .filter((t) => t.funnelStage !== null)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {prefix("Etiqueta")}
                  {t.name}
                </option>
              ))}
          </optgroup>
          <optgroup label="Outras etiquetas">
            {lookups.tags
              .filter((t) => t.funnelStage === null)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {prefix("Etiqueta")}
                  {t.name}
                </option>
              ))}
          </optgroup>
        </Select>
      </div>
      <div>
        <label htmlFor={`f-prioridade${stacked ? "-m" : ""}`} className={labelClass}>
          Prioridade
        </label>
        <Select
          id={`f-prioridade${stacked ? "-m" : ""}`}
          className={size}
          value={state.priority ?? ""}
          onChange={(e) => {
            const value = priorities.find((p) => p === e.target.value) ?? null;
            setState({ priority: value });
          }}
        >
          <option value="">{stacked ? "Todas" : "Prioridade"}</option>
          {priorities.map((p) => (
            <option key={p} value={p}>
              {prefix("Prioridade")}
              {PRIORITY_LABEL[p].label}
            </option>
          ))}
        </Select>
      </div>
    </>
  );
}
