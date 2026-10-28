"use client";

import { Button } from "@duckzap/ui/components/button";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { restartTourAction } from "../actions";

export function RestartTourButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <Button
        size="lg"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await restartTourAction();
            if (result.ok) router.push("/inicio?tour=1");
            else setError(result.error);
          })
        }
      >
        {pending ? "Preparando…" : "Refazer tour guiado"}
      </Button>
      {error ? (
        <p role="alert" className="mt-1.5 text-[13px] font-semibold text-err">
          {error}
        </p>
      ) : null}
    </div>
  );
}
