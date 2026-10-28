"use client";

import { ScreenError } from "@/components/screen-error";

export default function RootError({ error, reset }: { error: unknown; reset: () => void }) {
  return <ScreenError error={error} reset={reset} />;
}
