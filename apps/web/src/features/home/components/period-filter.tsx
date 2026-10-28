"use client";

import { homePeriodSchema, type HomePeriod } from "@duckzap/contracts/home";
import { Segmented } from "@duckzap/ui/components/segmented";
import { parseAsStringLiteral, useQueryState } from "nuqs";

const periods = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "custom", label: "Personalizado" },
] as const satisfies readonly { value: HomePeriod; label: string }[];

export const periodParser = parseAsStringLiteral(homePeriodSchema.options).withDefault("today");

// filtro na URL (?periodo=7d): recarregar ou compartilhar o link mantém a escolha
export function PeriodFilter() {
  const [period, setPeriod] = useQueryState("periodo", periodParser.withOptions({ shallow: false }));
  return <Segmented label="Período" options={periods} value={period} onChange={setPeriod} />;
}
