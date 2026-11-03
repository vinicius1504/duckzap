"use client";

import { RouteError, type RouteErrorProps } from "@/components/route-error";

export default function ConversationsError({ error, retry }: RouteErrorProps) {
  return <RouteError title="Conversas" error={error} retry={retry} />;
}
