"use client";

import { Icon } from "@duckzap/ui/components/icon";
import { Segmented } from "@duckzap/ui/components/segmented";
import { debounce, parseAsInteger, parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useState } from "react";

type Option<T extends string> = { value: T; label: string };

/**
 * Filtro rápido + busca, os dois na URL (?status=vencidas&q=ribeiro).
 * `shallow: false` faz o Server Component da página recarregar os dados.
 */
export function ListFilters<T extends string>({
  filterKey,
  filterLabel,
  options,
  defaultValue,
  searchLabel,
  searchPlaceholder,
}: {
  filterKey: string;
  filterLabel: string;
  options: readonly Option<T>[];
  defaultValue: T;
  searchLabel: string;
  searchPlaceholder: string;
}) {
  const values = options.map((o) => o.value);
  const [filter, setFilter] = useQueryState(
    filterKey,
    parseAsStringLiteral(values)
      .withDefault(defaultValue)
      .withOptions({ shallow: false, clearOnDefault: true }),
  );
  const [query, setQuery] = useQueryState(
    "q",
    parseAsString.withDefault("").withOptions({ shallow: false }),
  );
  const [, setPage] = useQueryState("pagina", parseAsInteger.withOptions({ shallow: false }));
  const [text, setText] = useState(query);

  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Segmented
        label={filterLabel}
        options={options}
        value={filter}
        onChange={(value) => {
          void setPage(null);
          void setFilter(value);
        }}
      />
      <div className="w-[min(340px,100%)]">
        <label htmlFor="busca-lista" className="sr-only">
          {searchLabel}
        </label>
        <div className="relative">
          <Icon
            name="search"
            size={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
          />
          <input
            id="busca-lista"
            type="search"
            value={text}
            placeholder={searchPlaceholder}
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              void setPage(null);
              void setQuery(value.trim() ? value : null, { limitUrlUpdates: debounce(350) });
            }}
            className="h-11 w-full rounded-control border border-field bg-surface pl-10 pr-3 text-ink placeholder:text-ink-2"
          />
        </div>
      </div>
    </div>
  );
}
