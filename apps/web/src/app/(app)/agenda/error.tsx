"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function AgendaError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Agenda" error={error} retry={retry} />;
}
