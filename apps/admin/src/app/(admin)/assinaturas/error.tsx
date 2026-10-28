"use client";

import { RouteError } from "@/components/route-error";

export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="Assinaturas" reset={reset} />;
}
