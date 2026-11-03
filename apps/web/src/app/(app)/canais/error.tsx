"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function CanaisError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Canais" error={error} retry={retry} />;
}
