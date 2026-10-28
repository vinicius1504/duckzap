"use client";

import {
  inviteIneligibleReasonSchema,
  splitIntoDays,
  type InviteIneligibleReason,
  type InviteOverview,
  type InviteResult,
} from "@duckzap/contracts/contacts";
import { Button } from "@duckzap/ui/components/button";
import { Dialog, DialogContent, DialogFooter } from "@duckzap/ui/components/dialog";
import { Alert, Progress } from "@duckzap/ui/components/feedback";
import { Select } from "@duckzap/ui/components/form-controls";
import { Label } from "@duckzap/ui/components/input";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { inviteContactsAction } from "../actions";
import { ineligibleLabel } from "../labels";

export type InviteAudience = {
  /** Quem pode receber agora. */
  eligibleIds: string[];
  ineligible: Partial<Record<InviteIneligibleReason, number>>;
  /** "selecionados" ou "toda a base". */
  scope: "selection" | "all";
};

function dayLabel(index: number) {
  return index === 0 ? "hoje" : index === 1 ? "amanhã" : `dia ${index + 1}`;
}

/** "Convidar contatos sem opt-in" (§5.7 item 7): uma vez por contato, até 20 convites/dia por número. */
export function InviteDialog({
  open,
  onOpenChange,
  audience,
  overview,
  sendingPaused,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audience: InviteAudience;
  overview: InviteOverview;
  sendingPaused: boolean;
  onSent?: () => void;
}) {
  const router = useRouter();
  const connected = overview.channels.filter((c) => c.connected);
  const [channelId, setChannelId] = useState(connected[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setError(null);
      setResult(null);
    }
  }, [open]);

  const channel = overview.channels.find((c) => c.id === channelId);
  const remainingToday = channel
    ? Math.max(0, Math.min(channel.inviteDailyLimit - channel.invitesSentToday, channel.channelDailyLimit - channel.messagesSentToday))
    : 0;
  const total = audience.eligibleIds.length;
  const days = channel ? splitIntoDays(total, remainingToday, channel.inviteDailyLimit) : [];
  const ineligibleTotal = Object.values(audience.ineligible).reduce((sum, n) => sum + (n ?? 0), 0);
  const preview = overview.messageTemplate.replace("{nome}", "Carla");

  function send() {
    startTransition(async () => {
      const res = await inviteContactsAction({ contactIds: audience.eligibleIds, channelId });
      if ("error" in res) return setError(res.error);
      setResult(res.data);
      onSent?.();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Convidar contatos sem opt-in"
        description="Uma mensagem única pergunta se a pessoa aceita receber mensagens da clínica. Só quem responder SIM entra em campanhas."
      >
        {result ? (
          <div className="flex flex-col gap-4">
            <Alert tone="ok" title={`${result.queued} convites na fila`}>
              {result.days.map((n, i) => `${dayLabel(i)}: ${n}`).join(" · ")}. O envio respeita intervalos aleatórios e o horário comercial.
            </Alert>
            {result.skipped.length ? (
              <p className="text-ink-2">{result.skipped.length} contatos ficaram de fora porque não podem receber o convite.</p>
            ) : null}
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Fechar
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-control border border-line p-3">
                <p className="text-[13px] text-ink-2">{audience.scope === "selection" ? "Selecionados que podem receber" : "Podem receber agora"}</p>
                <p className="text-[28px] font-extrabold">{total}</p>
              </div>
              <div className="rounded-control border border-line p-3">
                <p className="text-[13px] text-ink-2">Ficam de fora</p>
                <p className="text-[28px] font-extrabold">{ineligibleTotal}</p>
              </div>
            </div>

            {ineligibleTotal ? (
              <ul className="flex flex-col gap-1 text-[13px] text-ink-2">
                {inviteIneligibleReasonSchema.options
                  .filter((r) => (audience.ineligible[r] ?? 0) > 0)
                  .map((r) => (
                    <li key={r}>
                      <strong className="text-ink">{audience.ineligible[r]}</strong> {ineligibleLabel[r]}
                    </li>
                  ))}
              </ul>
            ) : null}

            <div>
              <Label htmlFor="convite-canal">Número que vai enviar</Label>
              <Select id="convite-canal" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                {overview.channels.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.connected}>
                    {c.name} · {c.provider === "qr" ? "QR Code" : "API oficial"}
                    {c.connected ? "" : " (desconectado)"}
                  </option>
                ))}
              </Select>
            </div>

            {channel ? (
              <div className="flex flex-col gap-2 rounded-control bg-surface-2 p-3">
                <div className="flex flex-wrap justify-between gap-2 text-[13px]">
                  <span>
                    Convites hoje: <strong>{channel.invitesSentToday} de {channel.inviteDailyLimit}</strong>
                  </span>
                  <span>
                    Mensagens do número hoje: <strong>{channel.messagesSentToday} de {channel.channelDailyLimit}</strong>
                  </span>
                </div>
                <Progress value={channel.invitesSentToday} max={channel.inviteDailyLimit} label="Convites enviados hoje" tone="duck" />
                {total > 0 ? (
                  <p className="text-[13px]">
                    <strong>
                      {total} {total === 1 ? "pessoa" : "pessoas"} → {days.length} {days.length === 1 ? "dia" : "dias"}
                    </strong>{" "}
                    ({days.map((n, i) => `${n} ${dayLabel(i)}`).join(" + ")})
                  </p>
                ) : null}
                {days.length > 2 ? (
                  <p className="text-[13px] text-ink-2">Recomendado: convide aos poucos, separando por lista ou segmento.</p>
                ) : null}
              </div>
            ) : (
              <Alert tone="warn">Nenhum número conectado. Reconecte um canal em Canais para convidar.</Alert>
            )}

            <div>
              <p className="mb-1.5 text-[13px] font-semibold">Mensagem do convite</p>
              <blockquote className="rounded-control border border-line bg-bg p-3">{preview}</blockquote>
              <p className="mt-1 text-[13px] text-ink-2">Sem oferta, preço, link ou mídia. A IA varia as palavras mantendo o sentido.</p>
            </div>

            <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-ink-2">
              <li>Cada contato recebe o convite uma vez só, para sempre. Sem reenvio.</li>
              <li>Quem não responder em 7 dias continua sem opt-in (o convite expira).</li>
              <li>
                Envio das {overview.sendWindow.start} às {overview.sendWindow.end}
                {overview.sendWindow.sundays ? "" : ", sem domingos"}, com intervalos aleatórios e pausas.
              </li>
              <li>O envio para sozinho se houver 3 recusas ou 2 falhas nas últimas 15 mensagens.</li>
              <li>Em números QR Code o risco de bloqueio é menor com esses cuidados, mas não é zero.</li>
            </ul>

            {sendingPaused ? <Alert tone="warn">O envio está pausado porque o plano expirou.</Alert> : null}
            {error ? (
              <Alert tone="err" live>
                {error}
              </Alert>
            ) : null}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
              <Button
                variant="primary"
                onClick={send}
                disabled={pending || sendingPaused || total === 0 || !channel?.connected}
              >
                {pending ? "Enviando…" : total === 0 ? "Ninguém para convidar" : `Convidar ${total} ${total === 1 ? "pessoa" : "pessoas"}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
