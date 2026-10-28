"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { resetOnboardingAction } from "../actions";

export function StartOverButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await resetOnboardingAction();
          router.replace("/comecar");
          router.refresh();
        })
      }
      className="min-h-11 text-[13px] font-semibold text-ink-2 underline disabled:opacity-60"
    >
      Criar outra conta
    </button>
  );
}
