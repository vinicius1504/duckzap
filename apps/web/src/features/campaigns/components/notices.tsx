import type { Campaign } from "@duckzap/contracts/campaigns";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Alert, EmptyState } from "@duckzap/ui/components/feedback";
import Link from "next/link";
import { pauseReasonView } from "../labels";

/** Faixa com o motivo da parada (automática ou manual). */
export function PauseBanner({ campaign }: { campaign: Pick<Campaign, "pauseReason" | "pauseDetail"> }) {
  if (!campaign.pauseReason) return null;
  const view = pauseReasonView[campaign.pauseReason];
  const automatic = campaign.pauseReason !== "manual";
  return (
    <Alert
      tone={automatic ? "warn" : "info"}
      title={automatic ? `Pausada automaticamente: ${view.title.toLowerCase()}` : view.title}
      action={
        campaign.pauseReason === "channel_disconnected" ? (
          <Link href="/canais" className={buttonVariants({ size: "sm" })}>
            Reconectar agora
          </Link>
        ) : undefined
      }
    >
      {campaign.pauseDetail ? `${campaign.pauseDetail} ` : null}
      {view.hint}
      {automatic ? " Ela só volta a enviar quando você retomar." : null}
    </Alert>
  );
}

export function SendingPausedAlert() {
  return (
    <Alert
      tone="err"
      title="Envios pausados"
      action={
        <Link href="/ajustes?aba=plano" className={buttonVariants({ size: "sm" })}>
          Renovar plano
        </Link>
      }
    >
      Seu plano expirou. Você ainda vê tudo, mas disparar e retomar campanhas fica desligado até renovar.
    </Alert>
  );
}

export function CampaignsPlanLock() {
  return (
    <Card>
      <EmptyState
        icon="send"
        title="Campanhas fazem parte do plano Pro"
        description="Envie mensagens para listas de clientes que aceitaram receber, com envio seguro e variações revisadas por você."
        action={
          <Link href="/ajustes?aba=plano" className={buttonVariants({ variant: "primary" })}>
            Conhecer os planos
          </Link>
        }
      />
    </Card>
  );
}
