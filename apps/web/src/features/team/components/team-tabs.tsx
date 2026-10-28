"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@duckzap/ui/components/tabs";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import type { ReactNode } from "react";

const tabs = ["pessoas", "equipes"] as const;
const tabParser = parseAsStringLiteral(tabs).withDefault("pessoas");

/** Abas na URL (?aba=equipes). Os dois painéis já vêm do servidor, então a troca é instantânea. */
export function TeamTabs({ people, teams }: { people: ReactNode; teams: ReactNode }) {
  const [tab, setTab] = useQueryState("aba", tabParser);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        const next = tabs.find((t) => t === value);
        if (next) void setTab(next);
      }}
      className="flex flex-col gap-[18px]"
    >
      <TabsList aria-label="Seções da equipe">
        <TabsTrigger value="pessoas">Pessoas</TabsTrigger>
        <TabsTrigger value="equipes">Equipes</TabsTrigger>
      </TabsList>
      <TabsContent value="pessoas">{people}</TabsContent>
      <TabsContent value="equipes">{teams}</TabsContent>
    </Tabs>
  );
}
