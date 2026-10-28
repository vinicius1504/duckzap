import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import Link from "next/link";

export default function AgentNotFound() {
  return (
    <Page>
      <Card>
        <EmptyState
          icon="bot"
          title="Agente não encontrado"
          description="Ele pode ter sido excluído ou o link está incompleto."
          action={
            <Link href="/agentes" className={buttonVariants({ variant: "primary" })}>
              Ver agentes
            </Link>
          }
        />
      </Card>
    </Page>
  );
}
