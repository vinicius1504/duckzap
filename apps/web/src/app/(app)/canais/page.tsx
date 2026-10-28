import { can } from "@duckzap/contracts/permissions";
import { buttonVariants } from "@duckzap/ui/components/button";
import { Card } from "@duckzap/ui/components/card";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert, EmptyState, Progress } from "@duckzap/ui/components/feedback";
import { Page, PageHeader } from "@duckzap/ui/components/layout";
import { Table, Td, Th } from "@duckzap/ui/components/table";
import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requirePermission } from "@/features/auth/permissions";
import { getChannelsOverview } from "@/features/channels/api";
import { ChannelRowActions } from "@/features/channels/components/channel-row-actions";
import { ChannelSettingsForm } from "@/features/channels/components/channel-settings-form";
import { ConnectDialog } from "@/features/channels/components/connect-dialog";
import { channelStatusView, channelTypeLabel } from "@/features/channels/components/labels";
import { NewChannelWizard } from "@/features/channels/components/new-channel-wizard";
import { formatPhone } from "@/lib/format";

export const metadata: Metadata = { title: "Canais" };

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ canal?: string }> }) {
  const session = await requirePermission("channel.manage");
  const canBill = can(session.user.role, "billing.manage");
  const selectedId = z.string().max(64).optional().catch(undefined).parse((await searchParams).canal);
  const data = await getChannelsOverview();
  const { channels, teams, agents, limit } = data;
  const nameOf = (list: { id: string; name: string }[], id: string | null) => list.find((x) => x.id === id)?.name ?? "—";
  const down = channels.filter((c) => c.status === "disconnected" || c.status === "banned");
  const selected = channels.find((c) => c.id === selectedId) ?? channels.find((c) => c.isDefault) ?? channels[0];
  const limitReached = limit.max !== null && limit.used >= limit.max;
  const nearLimit = limit.max !== null && limit.used >= limit.max - 1;

  return (
    <Page className="gap-[18px]">
      <PageHeader
        title="Canais"
        description="Os números e contas por onde seus clientes falam com você."
        actions={<NewChannelWizard allowedTypes={data.allowedTypes} limitReached={limitReached} limitMax={limit.max} />}
      />

      {down.map((channel) =>
        channel.status === "banned" ? (
          <Alert
            key={channel.id}
            tone="err"
            title={`${channel.name} foi bloqueado pelo WhatsApp.`}
            action={
              <Link href="/ajuda?q=bloqueado" className={buttonVariants({ size: "sm" })}>
                O que fazer
              </Link>
            }
          >
            Este número não envia nem recebe mensagens. Considere migrar para a API oficial.
          </Alert>
        ) : (
          <Alert
            key={channel.id}
            tone="err"
            title={`${channel.name} está desconectado.`}
            action={<ConnectDialog channel={channel} label="Reconectar agora" variant="secondary" />}
          >
            Mensagens deste número não chegam até reconectar.
          </Alert>
        ),
      )}

      {channels.length ? (
        <Table minWidth={900}>
          <thead>
            <tr>
              <Th>Canal</Th>
              <Th>Tipo</Th>
              <Th>Status</Th>
              <Th>Número / conta</Th>
              <Th>Equipe</Th>
              <Th>Agente</Th>
              <Th>
                <span className="sr-only">Ações</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => {
              const status = channelStatusView[channel.status];
              return (
                <tr key={channel.id}>
                  <Td>
                    <strong>{channel.name}</strong>
                    {channel.isDefault ? <Chip className="ml-1.5 bg-duck text-on-duck">Padrão</Chip> : null}
                  </Td>
                  <Td>{channelTypeLabel[channel.type]}</Td>
                  <Td>
                    <Chip tone={status.tone}>
                      <span className="size-2 rounded-full bg-current" aria-hidden="true" />
                      {status.label}
                    </Chip>
                  </Td>
                  <Td>
                    {channel.address
                      ? channel.type === "instagram"
                        ? channel.address
                        : formatPhone(channel.address)
                      : channel.type === "instagram"
                        ? "Instagram profissional"
                        : "—"}
                  </Td>
                  <Td>{nameOf(teams, channel.teamId)}</Td>
                  <Td>{nameOf(agents, channel.agentId)}</Td>
                  <Td>
                    <ChannelRowActions channel={channel} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <Card>
          <EmptyState
            icon="link"
            title="Nenhum canal ainda"
            description="Conecte seu WhatsApp por QR Code ou pela API oficial para começar a receber mensagens."
          />
        </Card>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-0 flex-[2_1_520px]">
          {selected ? (
            <ChannelSettingsForm key={selected.id} channel={selected} teams={teams} agents={agents} />
          ) : null}
        </div>
        <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
          <Card className="p-[18px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-bold">Limite do plano</h2>
              <Chip tone={limitReached ? "err" : nearLimit ? "warn" : "neutral"}>
                {limit.max === null ? `${limit.used} canais · ilimitado` : `${limit.used} de ${limit.max} canais`}
              </Chip>
            </div>
            {limit.max !== null ? (
              <div className="my-3">
                <Progress value={limit.used} max={limit.max} label="Canais usados do plano" tone={limitReached ? "err" : "ink"} />
              </div>
            ) : null}
            <p className="text-[13px] text-ink-2">
              {limit.max === null
                ? "Seu plano não limita a quantidade de canais."
                : limitReached
                  ? "Você usou todos os canais do plano. Mude de plano para adicionar outro."
                  : `Quando chegar a ${limit.max}, será preciso mudar de plano para adicionar outro canal.`}
              {canBill ? "" : " Só o proprietário pode mudar o plano."}
            </p>
            {canBill ? (
              <Link href="/ajustes?aba=plano" className={buttonVariants({ size: "sm", className: "mt-3" })}>
                Ver planos
              </Link>
            ) : null}
          </Card>
          <Card className="p-[18px]">
            <h2 className="font-bold">Primeiro uso</h2>
            <ol className="mt-2 list-decimal pl-[18px] text-[13px] text-ink-2">
              <li>Conecte um número</li>
              <li>Vincule uma equipe</li>
              <li>Escolha o agente que atende</li>
            </ol>
          </Card>
        </aside>
      </div>
    </Page>
  );
}
