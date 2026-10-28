"use client";

import { RouteError } from "@/components/route-error";

export default function SectionError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="Sem acesso" error={error} retry={retry} />;
}
