"use client";

import { RouteError } from "@/components/route-error";

export default function ErrorBoundary({ reset }: { error: unknown; reset: () => void }) {
  return <RouteError title="Mais" reset={reset} />;
}
