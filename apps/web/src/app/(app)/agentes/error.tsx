"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function AgentsRouteError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Agentes" error={error} retry={retry} />;
}
