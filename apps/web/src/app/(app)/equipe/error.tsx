"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function EquipeError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Equipe" error={error} retry={retry} />;
}
