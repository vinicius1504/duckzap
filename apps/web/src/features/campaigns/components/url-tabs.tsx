"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@duckzap/ui/components/tabs";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import type { ReactNode } from "react";

type Tab<T extends string> = { value: T; label: string; badge?: number; content: ReactNode };

/** Abas ligadas à URL (?aba=…): recarregar ou compartilhar o link mantém a aba. */
export function UrlTabs<T extends string>({
  tabs,
  defaultValue,
  label,
  param = "aba",
}: {
  tabs: readonly Tab<T>[];
  defaultValue: T;
  label: string;
  param?: string;
}) {
  const values = tabs.map((t) => t.value);
  const [tab, setTab] = useQueryState(param, parseAsStringLiteral(values).withDefault(defaultValue));

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        const next = tabs.find((t) => t.value === value);
        if (next) void setTab(next.value);
      }}
    >
      <TabsList aria-label={label}>
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value} className="max-md:min-h-11">
            {t.label}
            {t.badge !== undefined ? (
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">{t.badge}</span>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} className="pt-5">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
