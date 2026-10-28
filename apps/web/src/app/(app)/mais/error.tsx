"use client";

import { RouteError } from "@/components/route-error";

export default function SectionError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError title="Mais" error={error} retry={retry} />;
}
