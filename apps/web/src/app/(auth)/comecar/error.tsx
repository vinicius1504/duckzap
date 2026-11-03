"use client";

import { AuthRouteError } from "@/components/route-error";

export default function OnboardingError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <AuthRouteError
      title="Não foi possível carregar esta etapa"
      description="Pode ser uma falha passageira. O que você já preencheu está guardado."
      error={error}
      retry={retry}
    />
  );
}
