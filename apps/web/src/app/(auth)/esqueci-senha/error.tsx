"use client";

import { AuthRouteError } from "@/components/route-error";

export default function ForgotPasswordError({ error, retry }: { error: unknown; retry: () => void }) {
  return <AuthRouteError title="Não foi possível carregar esta página" description="Pode ser uma falha passageira." error={error} retry={retry} />;
}
