"use client";

import { splitIntoDays } from "@duckzap/contracts/campaigns";
import { Chip } from "@duckzap/ui/components/chip";
import { Alert } from "@duckzap/ui/components/feedback";
import { Input, Label } from "@duckzap/ui/components/input";
import Link from "next/link";
import { describeSplit } from "../../labels";
import { OptionCard } from "./option-card";
import type { StepProps } from "./types";
import { audienceOf, channelOf } from "./validate";

export function StepAudience({ draft, update, ctx }: StepProps) {
  const audience = audienceOf(draft, ctx);
  const channel = channelOf(draft, ctx);
  const isQr = channel?.kind === "whatsapp_qr";
  const days = audience && channel && isQr ? splitIntoDays(audience.optedIn, channel.dailyLimit, channel.sentToday) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xl">
        <Label htmlFor="cmp-name">Nome da campanha</Label>
        <Input
          id="cmp-name"
          value={draft.name}
          maxLength={80}
          placeholder="Ex.: Retorno de limpeza — outubro"
          onChange={(e) => update({ name: e.target.value })}
        />
        <p className="mt-1 text-xs text-ink-2">Só a sua equipe vê este nome.</p>
      </div>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 text-[13px] font-semibold">Para quem enviar</legend>
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr))]">
          {ctx.audiences.map((a) => (
            <OptionCard
              key={a.id}
              name="audience"
              value={a.id}
              checked={draft.audienceId === a.id}
              onSelect={() => update({ audienceId: a.id })}
              aside={<Chip>{a.kind === "list" ? "Lista" : "Segmento"}</Chip>}
            >
              <strong className="block">{a.name}</strong>
              <span className="text-[13px] text-ink-2">
                {a.optedIn} de {a.total} aceitaram receber
              </span>
            </OptionCard>
          ))}
        </div>
      </fieldset>

      {audience ? (
        <Alert tone="info" title={`${audience.name} · ${audience.optedIn} pessoas`}>
          Só recebe quem aceitou receber.
          {audience.notOptedIn ? ` ${audience.notOptedIn} não aceitaram e serão ignoradas.` : ""}
          {audience.optedOut ? ` ${audience.optedOut} pediram para sair e estão bloqueadas.` : ""}
          {audience.duplicates ? ` ${audience.duplicates} número repetido removido.` : ""} A ordem de envio é embaralhada, e quem
          conversou com vocês nos últimos 90 dias ({audience.recentlyActive}) vai primeiro.
        </Alert>
      ) : null}
      {audience && audience.notOptedIn > 0 ? (
        <p className="-mt-3 text-[13px] text-ink-2">
          Quer alcançar quem ainda não aceitou?{" "}
          <Link href="/clientes?consentimento=pendente" className="font-semibold underline underline-offset-2">
            Convidar contatos sem opt-in
          </Link>{" "}
          (um convite único por pessoa).
        </p>
      ) : null}

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 text-[13px] font-semibold">Enviar pelo número</legend>
        <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr))]">
          {ctx.channels.map((c) => (
            <OptionCard
              key={c.id}
              name="channel"
              value={c.id}
              checked={draft.sending.channelId === c.id}
              disabled={!c.connected}
              onSelect={() =>
                update({
                  sending: { ...draft.sending, channelId: c.id },
                  message: { ...draft.message, officialTemplateId: c.kind === "whatsapp_official" ? draft.message.officialTemplateId : null },
                })
              }
              aside={
                <Chip tone={c.connected ? "ok" : "err"}>{c.connected ? "Conectado" : "Desconectado"}</Chip>
              }
            >
              <strong className="block">{c.name}</strong>
              <span className="block text-[13px] text-ink-2">
                {c.kind === "whatsapp_qr" ? "WhatsApp por QR Code" : "WhatsApp API oficial"}
              </span>
              <span className="block text-xs text-ink-2">
                {c.kind === "whatsapp_qr"
                  ? `Até ${c.dailyLimit}/dia${c.numberAgeDays <= 7 ? ` (aquecimento, dia ${c.numberAgeDays})` : ""} · ${c.sentToday} enviadas hoje`
                  : "Só modelos aprovados pela Meta"}
              </span>
              {!c.connected ? (
                <Link href="/canais" className="mt-1 inline-block text-xs font-semibold underline underline-offset-2">
                  Reconectar agora
                </Link>
              ) : null}
            </OptionCard>
          ))}
        </div>
      </fieldset>

      {isQr ? (
        <Alert tone="warn" title="Número por QR Code não é oficial.">
          O envio segue o modo seguro (limites por dia, intervalos aleatórios, mensagens variadas), mas o risco de bloqueio do número
          não é zero. Para volume maior, prefira a API oficial.
        </Alert>
      ) : null}

      {audience && days.length > 1 ? (
        <Alert tone="info" title={`${audience.optedIn} pessoas → ${describeSplit(days)}`}>
          O número envia no máximo {channel?.dailyLimit} mensagens de campanha por dia
          {channel?.sentToday ? ` e hoje já enviou ${channel.sentToday}` : ""}. A campanha é dividida sozinha. Recomendamos campanhas
          menores, separadas por segmento.
        </Alert>
      ) : null}
    </div>
  );
}
