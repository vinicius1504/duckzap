"use client";

import { ScreenError } from "@/components/screen-error";

export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  return <ScreenError error={error} retry={retry} />;
}
