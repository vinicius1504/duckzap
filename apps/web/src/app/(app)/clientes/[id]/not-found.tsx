import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import Link from "next/link";

export default function ContactNotFound() {
  return (
    <Page>
      <Card>
        <EmptyState
          icon="contacts"
          title="Cliente não encontrado"
          description="Ele pode ter sido excluído."
          action={
            <Link href="/clientes" className={buttonVariants({ variant: "primary" })}>
              Ver clientes
            </Link>
          }
        />
      </Card>
    </Page>
  );
}
