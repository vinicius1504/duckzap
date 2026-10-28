import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Sem acesso" };

export default function NoAccessPage() {
  return (
    <Page>
      <Card>
        <EmptyState
          icon="shield"
          title="Você não tem acesso a esta área"
          description="Seu papel na equipe não permite abrir esta página. Se precisar, peça a um administrador."
          action={
            <Link href="/inicio" className={buttonVariants({ variant: "primary" })}>
              Voltar ao Início
            </Link>
          }
        />
      </Card>
    </Page>
  );
}
