import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Page } from "@duckzap/ui/components/layout";
import Link from "next/link";

export default function CampaignNotFound() {
  return (
    <Page>
      <Card>
        <EmptyState
          icon="search"
          title="Campanha não encontrada"
          description="Ela pode ter sido excluída ou o link está incompleto."
          action={
            <Link href="/campanhas" className={buttonVariants({ variant: "primary" })}>
              Ver campanhas
            </Link>
          }
        />
      </Card>
    </Page>
  );
}
