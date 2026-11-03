"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function AjustesError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Configurações" error={error} retry={retry} />;
}
