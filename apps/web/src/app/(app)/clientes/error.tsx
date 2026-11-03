"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function ContactsError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Clientes" error={error} retry={retry} />;
}
