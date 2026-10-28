"use client";

import { Button } from "@duckzap/ui/components/button";
import { Alert } from "@duckzap/ui/components/feedback";
import { Icon } from "@duckzap/ui/components/icon";
import { cn } from "@duckzap/ui/cn";
import { formatDate, formatDuration } from "@/lib/format";
import { describeSplit, messageTypeLabel } from "../../labels";
import { PhonePreview } from "../phone-preview";
import { computeDayPlan } from "./step-sending";
import type { StepProps } from "./types";
import { validateStep } from "./validate";

export function StepReview({ draft, ctx, termsAccepted, onEdit }: StepProps & { termsAccepted: boolean; onEdit: (step: number) => void }) {
  const { days, audience, channel } = computeDayPlan(draft, ctx);
  const isQr = channel?.kind === "whatsapp_qr";
  const s = draft.sending;
  const approved = draft.variations.filter((v) => v.review === "approved").length;
  const tz = ctx.timeZone;

  const rows = [
    { step: 0, label: "Campanha", value: draft.name || "—" },
    { step: 0, label: "Público", value: audience ? `${audience.name} · ${audience.optedIn} pessoas que aceitaram receber` : "—" },
    { step: 0, label: "Número", value: channel ? `${channel.name} · ${isQr ? "QR Code" : "API oficial"}` : "—" },
    { step: 1, label: "Mensagem", value: messageTypeLabel[draft.message.type] },
    ...(isQr
      ? [{ step: 1, label: "Variações", value: `${approved} aprovadas · ${draft.variationMode === "bank" ? "sorteio do banco" : "nova a cada mensagem"}` }]
      : []),
    {
      step: 2,
      label: "Quando",
      value:
        s.scheduleMode === "scheduled" && s.scheduledAt
          ? formatDate(s.scheduledAt, { weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" }, tz)
          : "Assim que disparar",
    },
    { step: 2, label: "Janela", value: `${s.windowStart} às ${s.windowEnd}${s.skipSundaysAndHolidays ? ", sem domingos e feriados" : ""}` },
    ...(isQr
      ? [
          { step: 2, label: "Intervalo", value: `aleatório entre ${formatDuration(s.intervalMinSeconds)} e ${formatDuration(s.intervalMaxSeconds)}` },
          { step: 2, label: "Divisão", value: audience ? `${audience.optedIn} pessoas → ${describeSplit(days)}` : "—" },
        ]
      : []),
  ];

  const checks = [
    { ok: validateStep(0, draft, ctx).length === 0, text: "Só contatos com opt-in registrado" },
    { ok: validateStep(1, draft, ctx).length === 0, text: isQr ? "Variações revisadas e aprovadas" : "Modelo aprovado pela Meta" },
    { ok: draft.message.optOutLine.length > 0, text: "Linha de saída no fim de toda mensagem" },
    { ok: validateStep(2, draft, ctx).length === 0, text: "Horário e ritmo de envio" },
    { ok: termsAccepted, text: termsAccepted ? "Termos de campanhas aceitos" : "Termos de campanhas (você aceita ao disparar)" },
  ];

  return (
    <div className="flex flex-wrap items-start gap-8">
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-5">
        <dl className="divide-y divide-line rounded-control border border-line">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5">
              <dt className="w-24 shrink-0 text-[13px] text-ink-2">{r.label}</dt>
              <dd className="min-w-0 flex-1 font-semibold">{r.value}</dd>
              <Button size="sm" variant="ghost" onClick={() => onEdit(r.step)} aria-label={`Alterar ${r.label.toLowerCase()}`} className="max-md:h-11">
                Alterar
              </Button>
            </div>
          ))}
        </dl>

        <ul className="flex flex-col gap-1.5" aria-label="Conferência antes do disparo">
          {checks.map((c) => (
            <li key={c.text} className={cn("flex items-center gap-2 text-[13px]", c.ok ? "text-ok" : "text-warn")}>
              <Icon name={c.ok ? "check" : "alert"} size={16} />
              <span className="text-ink">{c.text}</span>
            </li>
          ))}
        </ul>

        {isQr ? (
          <Alert tone="warn" title="O risco não é zero.">
            Mesmo com limites, intervalos e variações, o WhatsApp pode restringir números por QR Code. Se houver falhas demais, pedidos
            de saída ou o canal cair, a campanha pausa sozinha e só volta quando você retomar.
          </Alert>
        ) : null}
      </div>
      <div className="flex-[0_1_300px] max-md:mx-auto">
        <PhonePreview message={draft.message} text={isQr ? undefined : draft.message.body} senderName={ctx.companyName} />
      </div>
    </div>
  );
}
