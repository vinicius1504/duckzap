import { buttonVariants } from "@duckzap/ui/components/button";
import { EmptyState } from "@duckzap/ui/components/feedback";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <div className="w-full max-w-md rounded-card border border-line bg-surface">
        <EmptyState
          icon="search"
          title="Página não encontrada"
          description="O endereço pode estar errado ou a página mudou de lugar."
          action={
            <Link href="/visao-geral" className={buttonVariants({ variant: "primary" })}>
              Ir para a visão geral
            </Link>
          }
        />
      </div>
    </main>
  );
}
