"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function CatalogError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Catálogo" error={error} retry={retry} />;
}
