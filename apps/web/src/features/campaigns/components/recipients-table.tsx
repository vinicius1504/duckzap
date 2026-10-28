import type { CampaignRecipient } from "@duckzap/contracts/campaigns";
import { Chip } from "@duckzap/ui/components/chip";
import { Card } from "@duckzap/ui/components/card";
import { EmptyState } from "@duckzap/ui/components/feedback";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import Link from "next/link";
import { formatDate, formatDuration } from "@/lib/format";
import { recipientStatusView } from "../labels";

const when = (iso: string | null, tz: string) =>
  iso ? formatDate(iso, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }, tz) : "—";

/** Rejeitados: opt-out, sem WhatsApp, falha. `showCampaign` na visão geral (todas as campanhas). */
export function RejectedTable({ rows, timeZone, showCampaign }: { rows: CampaignRecipient[]; timeZone: string; showCampaign?: boolean }) {
  if (!rows.length)
    return (
      <Card>
        <EmptyState icon="check" title="Ninguém rejeitado" description="Quem pedir para sair, não tiver WhatsApp ou tiver falha de entrega aparece aqui." />
      </Card>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">
        Quem pediu para sair nunca mais recebe campanhas. Números sem WhatsApp são removidos antes do envio.
      </p>
      <Table minWidth={showCampaign ? 720 : 560}>
        <thead>
          <tr>
            <Th>Número</Th>
            <Th>Cliente</Th>
            {showCampaign ? <Th>Campanha</Th> : null}
            <Th>Motivo</Th>
            <Th>Quando</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap tabular-nums">{r.phoneMasked}</Td>
              <Td className="font-semibold">{r.contactName}</Td>
              {showCampaign ? (
                <Td>
                  <Link href={`/campanhas/${r.campaignId}`} className="underline-offset-2 hover:underline">
                    {r.campaignName}
                  </Link>
                </Td>
              ) : null}
              <Td>
                <Chip tone={recipientStatusView[r.status].tone}>{recipientStatusView[r.status].label}</Chip>
              </Td>
              <Td className="whitespace-nowrap text-ink-2">{when(r.at, timeZone)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** Registro de cada envio: variação usada, intervalo sorteado, horário e status (§5.7 item 6). */
export function SendLogTable({ rows, timeZone, usesVariations }: { rows: CampaignRecipient[]; timeZone: string; usesVariations: boolean }) {
  if (!rows.length)
    return (
      <Card>
        <EmptyState icon="send" title="Nenhum envio ainda" description="Assim que a campanha começar, cada mensagem aparece aqui." />
      </Card>
    );
  return (
    <Table minWidth={720}>
      <thead>
        <tr>
          <Th>Cliente</Th>
          <Th>Número</Th>
          <Th>Status</Th>
          {usesVariations ? <Th>Variação</Th> : null}
          <Th>Intervalo</Th>
          <Th>Horário</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="font-semibold">{r.contactName}</Td>
            <Td className="whitespace-nowrap tabular-nums text-ink-2">{r.phoneMasked}</Td>
            <Td>
              <Chip tone={recipientStatusView[r.status].tone}>{recipientStatusView[r.status].label}</Chip>
            </Td>
            {usesVariations ? <Td className="tabular-nums">{r.variationNumber ? `nº ${r.variationNumber}` : "—"}</Td> : null}
            <Td className="tabular-nums text-ink-2">{r.intervalSeconds ? formatDuration(r.intervalSeconds) : "—"}</Td>
            <Td className="whitespace-nowrap text-ink-2">{when(r.at, timeZone)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
