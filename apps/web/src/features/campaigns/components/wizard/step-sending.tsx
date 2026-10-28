"use client";

import {
  INTERVAL_FLOOR_SECONDS,
  SAFE_LIMITS,
  estimateDaySeconds,
  scheduleDays,
  splitIntoDays,
  type CampaignSending,
} from "@duckzap/contracts/campaigns";
import { Card } from "@duckzap/ui/components/card";
import { Alert } from "@duckzap/ui/components/feedback";
import { Checkbox } from "@duckzap/ui/components/form-controls";
import { Input, Label } from "@duckzap/ui/components/input";
import { Segmented } from "@duckzap/ui/components/segmented";
import { formatDate, formatDuration } from "@/lib/format";
import { describeSplit } from "../../labels";
import { fromLocalInput, toLocalInput } from "../../time";
import type { Draft, StepProps, WizardContext } from "./types";
import { audienceOf, channelOf } from "./validate";

/** Plano de dias calculado com as mesmas regras do worker (só canais QR). */
export function computeDayPlan(draft: Draft, ctx: WizardContext) {
  const audience = audienceOf(draft, ctx);
  const channel = channelOf(draft, ctx);
  if (!audience || !channel || channel.kind !== "whatsapp_qr") return { days: [], plan: [], audience, channel };
  const today = toLocalInput(new Date().toISOString(), ctx.timeZone).slice(0, 10);
  const s = draft.sending;
  const start = s.scheduleMode === "scheduled" && s.scheduledAt ? toLocalInput(s.scheduledAt, ctx.timeZone).slice(0, 10) : today;
  const days = splitIntoDays(audience.optedIn, channel.dailyLimit, start === today ? channel.sentToday : 0);
  return { days, plan: scheduleDays(days, start, s.skipSundaysAndHolidays), audience, channel };
}

export function StepSending({ draft, update, ctx }: StepProps) {
  const s = draft.sending;
  const setSending = (patch: Partial<CampaignSending>) => update({ sending: { ...s, ...patch } });
  const { days, plan, audience, channel } = computeDayPlan(draft, ctx);
  const isQr = channel?.kind === "whatsapp_qr";
  const tz = ctx.timeZone;

  return (
    <div className="flex flex-wrap items-start gap-8">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-6">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1.5 text-[13px] font-semibold">Quando enviar</legend>
          <Segmented
            label="Quando enviar"
            options={[
              { value: "now", label: "Assim que disparar" },
              { value: "scheduled", label: "Agendar" },
            ]}
            value={s.scheduleMode}
            onChange={(mode) => setSending({ scheduleMode: mode, scheduledAt: mode === "now" ? null : s.scheduledAt })}
          />
          {s.scheduleMode === "scheduled" ? (
            <div className="max-w-xs">
              <Label htmlFor="cmp-when">Data e hora (horário de Brasília)</Label>
              <Input
                id="cmp-when"
                type="datetime-local"
                value={s.scheduledAt ? toLocalInput(s.scheduledAt, tz) : ""}
                onChange={(e) => setSending({ scheduledAt: fromLocalInput(e.target.value, tz) })}
              />
            </div>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1.5 text-[13px] font-semibold">Janela de envio</legend>
          <div className="flex flex-wrap gap-3">
            <div className="w-36">
              <Label htmlFor="cmp-win-start">Das</Label>
              <Input id="cmp-win-start" type="time" value={s.windowStart} onChange={(e) => setSending({ windowStart: e.target.value })} />
            </div>
            <div className="w-36">
              <Label htmlFor="cmp-win-end">Até</Label>
              <Input id="cmp-win-end" type="time" value={s.windowEnd} onChange={(e) => setSending({ windowEnd: e.target.value })} />
            </div>
          </div>
          <label className="flex min-h-11 items-center gap-2.5">
            <Checkbox checked={s.skipSundaysAndHolidays} onChange={(e) => setSending({ skipSundaysAndHolidays: e.target.checked })} />
            Não enviar em domingos e feriados
          </label>
        </fieldset>

        {isQr ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1.5 text-[13px] font-semibold">Intervalo entre mensagens</legend>
            <div className="flex flex-wrap gap-3">
              <div className="w-36">
                <Label htmlFor="cmp-int-min">Mínimo (segundos)</Label>
                <Input
                  id="cmp-int-min"
                  type="number"
                  inputMode="numeric"
                  min={INTERVAL_FLOOR_SECONDS}
                  max={600}
                  value={s.intervalMinSeconds}
                  invalid={s.intervalMinSeconds < INTERVAL_FLOOR_SECONDS}
                  onChange={(e) => setSending({ intervalMinSeconds: Math.round(Number(e.target.value) || 0) })}
                  onBlur={() => setSending({ intervalMinSeconds: Math.max(INTERVAL_FLOOR_SECONDS, s.intervalMinSeconds) })}
                />
              </div>
              <div className="w-36">
                <Label htmlFor="cmp-int-max">Máximo (segundos)</Label>
                <Input
                  id="cmp-int-max"
                  type="number"
                  inputMode="numeric"
                  min={INTERVAL_FLOOR_SECONDS + 1}
                  max={900}
                  value={s.intervalMaxSeconds}
                  invalid={s.intervalMaxSeconds <= s.intervalMinSeconds}
                  onChange={(e) => setSending({ intervalMaxSeconds: Math.round(Number(e.target.value) || 0) })}
                />
              </div>
            </div>
            <p className="text-[13px] text-ink-2">
              Cada intervalo é sorteado entre o mínimo e o máximo (piso de {INTERVAL_FLOOR_SECONDS} s; padrão 45 s a 2 min), nunca dois
              iguais seguidos. A cada 8 a 15 mensagens há uma pausa longa de 5 a 15 min, e o número aparece “digitando” antes de enviar.
            </p>
          </fieldset>
        ) : (
          <Alert tone="info" title="API oficial">
            O ritmo é controlado pela Meta. Limite atual deste número: {channel?.dailyLimit.toLocaleString("pt-BR")} conversas por dia.
          </Alert>
        )}
      </div>

      {isQr && channel && audience ? (
        <Card className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 bg-bg p-4">
          <h3 className="font-bold">Envio seguro deste número</h3>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            <li>
              Até <strong>{channel.dailyLimit}</strong> mensagens de campanha por dia
              {channel.numberAgeDays <= 7 ? ` (número em aquecimento, dia ${channel.numberAgeDays})` : ""}
            </li>
            <li>
              Até <strong>~{Math.min(channel.hourlyLimit, SAFE_LIMITS.hourlyMax)}</strong> por hora
            </li>
            <li>Hoje já foram {channel.sentToday} de {channel.dailyLimit}. Respostas de atendimento não contam.</li>
          </ul>
          <p className="rounded-control bg-surface-2 p-2.5 font-semibold">
            {audience.optedIn} pessoas → {describeSplit(days)}
          </p>
          <ol className="flex flex-col gap-1.5 text-[13px]">
            {plan.map((d) => (
              <li key={d.date} className="flex justify-between gap-2 border-b border-line pb-1.5 last:border-0">
                <span className="capitalize">{formatDate(d.date, { weekday: "short", day: "2-digit", month: "2-digit" }, tz)}</span>
                <span>
                  <strong>{d.count}</strong> · cerca de{" "}
                  {formatDuration(estimateDaySeconds(d.count, s.intervalMinSeconds, s.intervalMaxSeconds, channel.hourlyLimit))}
                </span>
              </li>
            ))}
          </ol>
          {days.length > 1 ? (
            <p className="text-[13px] text-ink-2">
              Recomendado: campanhas menores, separadas por segmento. Volume baixo protege o número.
            </p>
          ) : null}
          {channel.numberAgeDays <= 7 ? (
            <p className="text-[13px] text-ink-2">
              Aquecimento: dias 1 a 3 até {SAFE_LIMITS.warmup[0].daily}/dia, dias 4 a 7 até {SAFE_LIMITS.warmup[1].daily}/dia, depois{" "}
              {SAFE_LIMITS.dailyMax}.
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
